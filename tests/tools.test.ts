import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api-client module before importing tools
vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  setApiKey: vi.fn(),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
}));

import { handleToolCall, toolDefinitions } from "../src/tools/index.js";
import { callApi } from "../src/lib/api-client.js";

const mockCallApi = vi.mocked(callApi);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("distribute_list_workflows", () => {
  // One workflow exactly as the deployed gateway serves it on GET /v1/workflows.
  const makeWorkflow = (overrides: Record<string, unknown> = {}) => ({
    id: "wf-1",
    workflowSlug: "sales-email-cold-outreach-sienna-v3",
    workflowName: "Cold outreach (Sienna) v3",
    displayName: null,
    workflowDynastyName: "Cold outreach (Sienna)",
    workflowDynastySlug: "sales-email-cold-outreach-sienna",
    version: 3,
    createdForBrandId: null,
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    featureSlug: "sales-cold-email-outreach",
    signature: "abc123",
    workflowDynastySignatureName: "sienna",
    status: "active",
    ...overrides,
  });

  it("calls GET /v1/workflows and returns the fields the gateway actually serves", async () => {
    mockCallApi.mockResolvedValue({
      data: {
        workflows: [makeWorkflow()],
      },
    });

    const result = await handleToolCall("distribute_list_workflows", {});

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows");
    expect(result).toEqual({
      workflows: [
        {
          workflowSlug: "sales-email-cold-outreach-sienna-v3",
          workflowDynastySlug: "sales-email-cold-outreach-sienna",
          displayName: "Cold outreach (Sienna)",
          version: 3,
          category: "sales",
          channel: "email",
          audienceType: "cold-outreach",
          featureSlug: "sales-cold-email-outreach",
          signatureName: "sienna",
          status: "active",
        },
      ],
    });
  });

  it("hands back the slug a campaign has to name", async () => {
    mockCallApi.mockResolvedValue({ data: { workflows: [makeWorkflow()] } });

    const result = (await handleToolCall("distribute_list_workflows", {})) as {
      workflows: Array<Record<string, unknown>>;
    };

    // The dynasty slug is what identifies a workflow lineage everywhere else in
    // the fleet, so it is the field this list has to carry.
    expect(result.workflows[0]!.workflowDynastySlug).toBe("sales-email-cold-outreach-sienna");
  });

  it("passes human_id filter as humanId query param", async () => {
    mockCallApi.mockResolvedValue({
      data: { workflows: [] },
    });

    await handleToolCall("distribute_list_workflows", { human_id: "human-abc123" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows?humanId=human-abc123");
  });

  it("sends no category filter — the gateway serves none", async () => {
    mockCallApi.mockResolvedValue({
      data: { workflows: [] },
    });

    await handleToolCall("distribute_list_workflows", { category: "sales" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows");
    expect(toolDefinitions.distribute_list_workflows.schema.shape).not.toHaveProperty("category");
  });

  it("falls back from displayName to the dynasty name, then the workflow name", async () => {
    mockCallApi.mockResolvedValue({
      data: {
        workflows: [
          makeWorkflow({ displayName: "Hormozi v1" }),
          makeWorkflow({ displayName: null }),
          makeWorkflow({ displayName: null, workflowDynastyName: null }),
        ],
      },
    });

    const result = (await handleToolCall("distribute_list_workflows", {})) as {
      workflows: Array<Record<string, unknown>>;
    };

    expect(result.workflows[0]!.displayName).toBe("Hormozi v1");
    expect(result.workflows[1]!.displayName).toBe("Cold outreach (Sienna)");
    expect(result.workflows[2]!.displayName).toBe("Cold outreach (Sienna) v3");
  });

  it("throws on API error", async () => {
    mockCallApi.mockResolvedValue({ error: "Unauthorized" });

    await expect(handleToolCall("distribute_list_workflows", {})).rejects.toThrow("Unauthorized");
  });
});

describe("distribute_list_campaigns", () => {
  it("defaults to every campaign", async () => {
    mockCallApi.mockResolvedValue({ data: { campaigns: [] } });

    await handleToolCall("distribute_list_campaigns", {});

    expect(mockCallApi).toHaveBeenCalledWith("/v1/campaigns?status=all");
  });

  it("offers the status vocabulary the gateway serves, and not a word it does not", () => {
    const schema = toolDefinitions.distribute_list_campaigns.schema;

    // Measured against production: asking for `active` returned 132 stopped rows
    // beside 2 running ones — the platform stores `ongoing`, and the gateway ignores
    // a status it does not recognise rather than refusing it, so the filter silently
    // did nothing at all.
    expect(schema.safeParse({ status: "ongoing" }).success).toBe(true);
    expect(schema.safeParse({ status: "stopped" }).success).toBe(true);
    expect(schema.safeParse({ status: "all" }).success).toBe(true);
    expect(schema.safeParse({ status: "active" }).success).toBe(false);
  });
});

describe("distribute_campaign_stats reads success first", () => {
  // The shape the deployed gateway serves on GET /v1/campaigns/{id}/stats, with
  // the numbers a real assistant once reported failures-first: "531 sent, 518
  // delivered, 13 bounces" instead of "98% delivered".
  const stats = (overrides: Record<string, unknown> = {}) => ({
    campaignId: "c1",
    leadsServed: 600,
    leadsContacted: 531,
    leadsBuffered: 0,
    leadsSkipped: 3,
    emailsGenerated: 540,
    totalCostUsd: 12.3,
    recipientStats: {
      contacted: 531,
      sent: 531,
      delivered: 518,
      opened: 120,
      bounced: 13,
      clicked: 4,
      unsubscribed: 2,
      repliesPositive: 3,
      repliesNegative: 5,
      repliesNeutral: 1,
      repliesAutoReply: 7,
      repliesDetail: {
        interested: 2,
        meetingBooked: 1,
        closed: 0,
        notInterested: 4,
        wrongPerson: 1,
        unsubscribe: 0,
        neutral: 1,
        autoReply: 7,
        outOfOffice: 0,
      },
    },
    emailStats: { sent: 900, delivered: 880, opened: 200, clicked: 4, bounced: 20, unsubscribed: 2, stepStats: [] },
    ...overrides,
  });

  it("leads with meetings, positive replies and delivery rate; failures come last", async () => {
    mockCallApi.mockResolvedValue({ data: stats() });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, unknown>;
    const keys = Object.keys(out);

    expect(keys[0]).toBe("headline");
    expect(keys[1]).toBe("summary");
    expect(keys[keys.length - 1]).toBe("failureDetails");
    expect(out.headline).toBe(
      "1 meetings booked, 3 positive replies, 97.6% delivered (518 of 531). 531 leads contacted, 900 emails sent, $12.30 spent.",
    );
    const summary = out.summary as Record<string, unknown>;
    expect(Object.keys(summary).slice(0, 5)).toEqual([
      "meetingsBooked",
      "positiveReplies",
      "moneyEarnedUsd",
      "roi",
      "deliveryRatePct",
    ]);
    expect(summary.deliveryRatePct).toBe(97.6);
    expect(out.failureDetails).toEqual({
      recipientsBounced: 13,
      emailsBounced: 20,
      unsubscribed: 2,
      negativeReplies: 5,
      notInterested: 4,
      wrongPerson: 1,
    });
  });

  it("keeps every field the gateway served (live callers read them)", async () => {
    mockCallApi.mockResolvedValue({ data: stats() });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, any>;

    for (const k of ["campaignId", "leadsServed", "leadsContacted", "emailsGenerated", "totalCostUsd", "recipientStats", "emailStats"]) {
      expect(out).toHaveProperty(k);
    }
    expect(out.recipientStats.bounced).toBe(13);
  });

  it("shows zeros plainly and invents no money figure", async () => {
    const zero = stats();
    zero.recipientStats = { ...zero.recipientStats, repliesPositive: 0, repliesDetail: { ...zero.recipientStats.repliesDetail, meetingBooked: 0 } };
    mockCallApi.mockResolvedValue({ data: zero });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, any>;

    expect(out.headline).toMatch(/^0 meetings booked, 0 positive replies/);
    expect(out.summary.meetingsBooked).toBe(0);
    expect(out.summary.moneyEarnedUsd).toBeNull();
    expect(out.summary.roi).toBeNull();
    expect(out.summary.notServed).toEqual(["moneyEarnedUsd", "roi"]);
  });

  it("gives no delivery rate before anything is sent, and says why", async () => {
    const empty = stats();
    empty.recipientStats = { ...empty.recipientStats, sent: 0, delivered: 0 };
    mockCallApi.mockResolvedValue({ data: empty });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, any>;

    expect(out.summary.deliveryRatePct).toBeNull();
    expect(out.headline).toContain("no delivery rate yet (nothing sent)");
  });

  it("tells the model to report success first", () => {
    expect(toolDefinitions.distribute_campaign_stats.description).toContain(
      "Report meetings, positive replies and delivery rate first",
    );
  });
});

describe("distribute_status says whose key this is", () => {
  it("names the organization, its brands, and the key's one-organization scope", async () => {
    mockCallApi.mockImplementation(async (path: string) =>
      path === "/v1/me"
        ? { data: { userId: "u1", orgId: "o1", authType: "user_key", orgName: "distribute.you" } }
        : { data: { brands: [{ id: "b1", name: "Acme", domain: "acme.com", offer: "long" }] } },
    );

    const out = (await handleToolCall("distribute_status", {})) as Record<string, any>;

    expect(out.status).toBe("connected");
    expect(out.organization).toEqual({ id: "o1", name: "distribute.you" });
    expect(out.brands).toEqual([{ id: "b1", name: "Acme", domain: "acme.com" }]);
    expect(out.keyScope).toContain("one user in one organization");
    expect(out.keyScope).toContain("never belongs to a single brand");
    expect(out.keyScope).toContain("staff or beta");
    // Unchanged for live callers.
    expect(out.user).toEqual({ userId: "u1", orgId: "o1", authType: "user_key", orgName: "distribute.you" });
  });

  it("reports the organization name as null while the API does not serve it", async () => {
    mockCallApi.mockImplementation(async (path: string) =>
      path === "/v1/me"
        ? { data: { userId: "u1", orgId: "o1", authType: "user_key" } }
        : { data: { brands: [] } },
    );

    const out = (await handleToolCall("distribute_status", {})) as Record<string, any>;

    expect(out.organization).toEqual({ id: "o1", name: null });
  });

  it("explains a refused key instead of a bare error", async () => {
    mockCallApi.mockResolvedValue({ error: "Invalid API key" });

    const out = (await handleToolCall("distribute_status", {})) as Record<string, any>;

    expect(out.status).toBe("error");
    expect(out.message).toBe("Invalid API key");
    expect(out.hint).toContain("revoked, deleted or mistyped");
    expect(out.hint).toContain("Authorization: Bearer");
  });
});
