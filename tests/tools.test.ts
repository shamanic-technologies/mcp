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
    // The gateway's own success-first block; deliveryRate is email-gateway's
    // served 0..1 ratio, copied through by api-service.
    headline: {
      meetingsBooked: 1,
      positiveReplies: 3,
      moneyEarnedInUsdCents: null,
      roi: null,
      deliveryRate: 0.9755,
      delivered: 518,
      sent: 531,
      costInUsdCents: "1230",
      notServed: ["moneyEarnedInUsdCents", "roi"],
      unavailable: [] as string[],
    },
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
    expect(summary.delivered).toBe(518);
    expect(summary.sent).toBe(531);
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

  it("shows the served delivery rate, not one computed from the counts", async () => {
    // Counts that would divide to 97.6%: the served ratio wins.
    const served = stats();
    served.headline = { ...served.headline, deliveryRate: 0.5 };
    mockCallApi.mockResolvedValue({ data: served });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, any>;

    expect(out.summary.deliveryRatePct).toBe(50);
    expect(out.headline).toContain("50% delivered (518 of 531)");
  });

  it("gives no delivery rate before anything is sent, and says why", async () => {
    const empty = stats();
    empty.headline = { ...empty.headline, deliveryRate: null, delivered: 0, sent: 0 };
    mockCallApi.mockResolvedValue({ data: empty });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, any>;

    expect(out.summary.deliveryRatePct).toBeNull();
    expect(out.headline).toContain("no delivery rate yet (nothing sent)");
  });

  it("keeps a null served rate null when something was sent", async () => {
    const contradicted = stats();
    contradicted.headline = { ...contradicted.headline, deliveryRate: null };
    mockCallApi.mockResolvedValue({ data: contradicted });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, any>;

    expect(out.summary.deliveryRatePct).toBeNull();
    expect(out.headline).toContain("delivery rate unknown");
  });

  it("tells the model to report success first", () => {
    expect(toolDefinitions.distribute_campaign_stats.description).toContain(
      "Report meetings, positive replies and delivery rate first",
    );
  });
});

describe("distribute_status says whose key this is", () => {
  // The shape the deployed gateway serves on GET /v1/me for a user key that
  // reaches two organizations and names neither.
  const me = {
    summary: "Acting as Ada (ada@acme.com). This key reaches 2 organizations: ...",
    user: { id: "u1", email: "ada@acme.com", firstName: "Ada", lastName: null },
    organizations: [
      { id: "o1", name: "Acme", brands: [{ id: "b1", name: "Acme", domain: "acme.com" }] },
      { id: "o2", name: "Globex", brands: [{ id: "b2", name: "Globex", domain: "globex.com" }, { id: "b3", name: "Initech", domain: "initech.com" }] },
    ],
    organization: null,
    brands: null,
    keyScope: "A distribute.you API key belongs to its USER and acts in every organization that user is a member of ...",
    lookupErrors: [],
    userId: "u1",
    orgId: null,
    authType: "user_key",
  };

  it("lists every organization the key reaches, each with its brands, from /v1/me alone", async () => {
    mockCallApi.mockResolvedValue({ data: me });

    const out = (await handleToolCall("distribute_status", {})) as Record<string, any>;

    expect(mockCallApi).toHaveBeenCalledTimes(1);
    expect(mockCallApi).toHaveBeenCalledWith("/v1/me");
    expect(out.status).toBe("connected");
    expect(out.organizations).toEqual(me.organizations);
    expect(out.organization).toBeNull();
    expect(out.user).toEqual(me.user);
    expect(out.summary).toBe(me.summary);
  });

  it("reports the key scope the gateway serves, and how to target a request", async () => {
    mockCallApi.mockResolvedValue({ data: me });

    const out = (await handleToolCall("distribute_status", {})) as Record<string, any>;

    expect(out.keyScope).toBe(me.keyScope);
    expect(out.howToTarget).toContain("pass brandId (and orgId if a brand sits in several orgs)");
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

describe("every brand/campaign read passes the caller's target through", () => {
  const cases: Array<[string, Record<string, unknown>, string, unknown]> = [
    ["distribute_list_brands", {}, "/v1/brands", { brands: [] }],
    ["distribute_list_campaigns", { status: "ongoing" }, "/v1/campaigns?status=ongoing", { campaigns: [] }],
    ["distribute_campaign_stats", { campaign_id: "c1" }, "/v1/campaigns/c1/stats", {}],
    ["distribute_list_workflows", {}, "/v1/workflows", { workflows: [] }],
  ];

  for (const [tool, args, path, data] of cases) {
    it(`${tool} forwards brandId and orgId as query parameters`, async () => {
      mockCallApi.mockResolvedValue({ data });
      await handleToolCall(tool, { ...args, brandId: "b2", orgId: "o2" });
      const sep = path.includes("?") ? "&" : "?";
      expect(mockCallApi).toHaveBeenCalledWith(`${path}${sep}brandId=b2&orgId=o2`);
    });

    it(`${tool} names nothing when the caller named nothing (no default org)`, async () => {
      mockCallApi.mockResolvedValue({ data });
      await handleToolCall(tool, args);
      expect(mockCallApi).toHaveBeenCalledWith(path);
    });

    it(`${tool} accepts an optional brandId and orgId`, () => {
      const shape = (toolDefinitions as Record<string, { schema: { shape: Record<string, unknown> } }>)[tool]!.schema.shape;
      expect(shape).toHaveProperty("brandId");
      expect(shape).toHaveProperty("orgId");
    });
  }

  it("suggest_icp with a brandId posts to that brand directly, no lookup", async () => {
    mockCallApi.mockResolvedValue({ data: { icp: "x" } });
    await handleToolCall("distribute_suggest_icp", { brandId: "b2", orgId: "o2" });
    expect(mockCallApi).toHaveBeenCalledTimes(1);
    expect(mockCallApi).toHaveBeenCalledWith("/v1/brands/b2/icp/suggest?orgId=o2", { method: "POST", body: {} });
  });

  it("suggest_icp by URL looks the brand up inside the targeted organization", async () => {
    mockCallApi.mockImplementation(async (path: string) =>
      path.startsWith("/v1/brands?")
        ? { data: { brands: [{ id: "b3", domain: "initech.com" }] } }
        : { data: { icp: "x" } },
    );
    await handleToolCall("distribute_suggest_icp", { brand_url: "https://www.initech.com/", orgId: "o2" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/brands?orgId=o2");
    expect(mockCallApi).toHaveBeenCalledWith("/v1/brands/b3/icp/suggest?orgId=o2", { method: "POST", body: {} });
  });

  it("every targeting tool tells the model to call distribute_status first", () => {
    for (const tool of ["distribute_list_brands", "distribute_list_campaigns", "distribute_campaign_stats", "distribute_list_workflows", "distribute_suggest_icp"]) {
      expect((toolDefinitions as Record<string, { description: string }>)[tool]!.description).toContain(
        "Call distribute_status first to list brands, then pass brandId (and orgId if a brand sits in several orgs).",
      );
    }
  });
});

describe("a multi-org call with no target surfaces the gateway's refusal as-is", () => {
  const refusal = {
    error: "Organization required",
    code: "org_target_required",
    message: "You belong to 2 organizations and this request named none.",
    fix: "Name a brand with ?brandId=<id> ... or the organization with ?orgId=<id>.",
    organizations: [{ id: "o1", name: "Acme" }, { id: "o2", name: "Globex" }],
  };

  for (const [tool, args] of [
    ["distribute_list_brands", {}],
    ["distribute_list_campaigns", {}],
    ["distribute_campaign_stats", { campaign_id: "c1" }],
    ["distribute_list_workflows", {}],
    ["distribute_suggest_icp", { brand_url: "acme.com" }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`${tool} throws code, message, fix and organizations, never a default`, async () => {
      mockCallApi.mockResolvedValue({ error: refusal.error, errorBody: refusal, status: 400 });

      const err = await handleToolCall(tool, args).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
      expect(JSON.parse(err!.message)).toEqual(refusal);
      expect(mockCallApi).toHaveBeenCalledTimes(1);
    });
  }
});
