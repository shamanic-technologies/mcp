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
    mockCallApi.mockResolvedValue({ data: { salesFunnelCampaigns: [] } });

    await handleToolCall("distribute_list_campaigns", {});

    expect(mockCallApi).toHaveBeenCalledWith("/v1/sales-funnel-campaigns");
  });

  // Production, 2026-10-07: campaign-service refuses any status but `ongoing` and
  // `stopped` with a 400, so sending `status=all` (or defaulting to it) broke the
  // tool for every caller that did not filter.
  it("sends no status for `all`, so the platform returns every campaign", async () => {
    mockCallApi.mockResolvedValue({ data: { salesFunnelCampaigns: [] } });

    await handleToolCall("distribute_list_campaigns", { status: "all", brandId: "b1" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/sales-funnel-campaigns?brandId=b1");
  });

  it("forwards `stopped` as a filter", async () => {
    mockCallApi.mockResolvedValue({ data: { salesFunnelCampaigns: [] } });

    await handleToolCall("distribute_list_campaigns", { status: "stopped", brandId: "b1" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/sales-funnel-campaigns?status=stopped&brandId=b1");
  });

  it("offers the status vocabulary the gateway serves, and not a word it does not", () => {
    const schema = toolDefinitions.distribute_list_campaigns.schema;

    // The platform stores `ongoing` and `stopped` and refuses any other word; `all`
    // is the tool's own word for "no filter" and never reaches the platform.
    expect(schema.safeParse({ status: "ongoing" }).success).toBe(true);
    expect(schema.safeParse({ status: "stopped" }).success).toBe(true);
    expect(schema.safeParse({ status: "all" }).success).toBe(true);
    expect(schema.safeParse({ status: "active" }).success).toBe(false);
  });
});

// A campaign as the deployed gateway serves it on GET /v1/sales-funnel-campaigns (NOVEMIQ's
// "Bliss", prod 2026-10-11): one campaign, run as one, with a part per channel step.
const bliss = {
  id: "sfc-bliss",
  orgId: "o1",
  brandId: "b1",
  offerId: "off1",
  salesFunnelId: "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked",
  salesFunnelName: "Bliss",
  status: "ongoing",
  stopReason: null,
  createdAt: "2026-10-10T13:48:01.383Z",
  updatedAt: "2026-10-10T13:48:01.383Z",
  units: [
    { campaignId: "u-email", pipeId: "sales-cold-email-outreach|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", status: "ongoing", workflowSlug: "wf", name: "Bliss 7fcf42ab - NOVEMIQ (Positive replies, Cold email)" },
    { campaignId: "u-apollo", pipeId: "sourcing-apollo-cold-filters|start_to_lead_found", featureSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", status: "ongoing", workflowSlug: null, name: "Bliss 7fcf42ab - sourcing-apollo-cold-filters - x" },
  ],
};
// billing's caps read for it (prod body, trimmed).
const blissCaps = {
  salesFunnelId: bliss.salesFunnelId,
  stated: true,
  salesFunnelName: "Bliss",
  salesFunnelType: "proactive",
  salesFunnelTypeUnavailableReason: null,
  maxBudget: {
    amountCents: "1000.0000000000",
    period: "daily",
    dailyBudgetCents: "1000.0000000000",
    consumedCents: "1006.0514720000",
    remainingCents: "0.0000000000",
    reached: true,
    consumedUnavailableReason: null,
  },
  maxVolume: null,
};
const catalogue = {
  channels: [
    { slug: "sales-cold-email-outreach", name: "Sales Cold Email Outreach", stepTransitions: [{ legKey: "lead_found_to_conversation", to: { key: "conversation", label: "Positive reply" } }] },
    { slug: "sourcing-apollo-cold-filters", name: "Apollo Cold Filters", stepTransitions: [{ legKey: "start_to_lead_found", to: { key: "lead_found", label: "Lead found" } }] },
  ],
  legKeyCorrespondence: [{ legacyLegKey: "start_to_conversation", legKey: "lead_found_to_conversation" }],
};

/** Answer each gateway path from a table; an unknown path fails the test loudly. */
function routeApi(table: Record<string, unknown>) {
  mockCallApi.mockImplementation(async (path: string) => {
    const bare = path.split("?")[0]!;
    if (!(bare in table)) throw new Error(`unexpected gateway call ${path}`);
    return { data: table[bare] };
  });
}

describe("distribute_list_campaigns lists campaigns, never their parts", () => {
  const capsPath = `/v1/brands/b1/offers/off1/sales-funnels/${encodeURIComponent(bliss.salesFunnelId)}/caps`;

  it("names each campaign, with its type and limits in words", async () => {
    routeApi({ "/v1/sales-funnel-campaigns": { salesFunnelCampaigns: [bliss] }, [capsPath]: blissCaps });

    const out = (await handleToolCall("distribute_list_campaigns", { brandId: "b1" })) as { campaigns: Array<Record<string, any>> };

    expect(out.campaigns).toHaveLength(1);
    const c = out.campaigns[0]!;
    expect(c.id).toBe("sfc-bliss");
    expect(c.name).toBe("Bliss");
    expect(c.status).toBe("ongoing");
    expect(c.type).toBe("proactive");
    expect(c.budget).toBe("Max $10/day");
    expect(c.volume).toBeNull();
    expect(c.maxBudgetDailyUsd).toBe(10);
    expect(c.maxBudget).toEqual({ amountUsd: 10, period: "daily", spentThisPeriodUsd: 10.06, remainingUsd: 0, reached: true, spentUnavailableReason: null });
    expect(c.noBudgetSet).toBe(false);
    expect(mockCallApi).toHaveBeenCalledWith(`${capsPath}?brandId=b1`);
  });

  it("hands back no part, no part name and no part count", async () => {
    routeApi({ "/v1/sales-funnel-campaigns": { salesFunnelCampaigns: [bliss] }, [capsPath]: blissCaps });

    const out = await handleToolCall("distribute_list_campaigns", { brandId: "b1" });
    const text = JSON.stringify(out);

    expect(text).not.toContain("u-email");
    expect(text).not.toContain("NOVEMIQ (Positive replies");
    expect(text).not.toContain("units");
    expect(text.toLowerCase()).not.toMatch(/funnel|pipe|\bleg/);
  });

  it("says a reactive campaign's limit as an upper bound", async () => {
    routeApi({
      "/v1/sales-funnel-campaigns": { salesFunnelCampaigns: [bliss] },
      [capsPath]: {
        ...blissCaps,
        salesFunnelType: "reactive",
        maxBudget: { ...blissCaps.maxBudget, amountCents: "100", dailyBudgetCents: "0" },
        maxVolume: { count: 50, period: "weekly", unit: "prospects_handled", consumed: 3, remaining: 47, reached: false, consumedUnavailableReason: null },
      },
    });

    const out = (await handleToolCall("distribute_list_campaigns", {})) as { campaigns: Array<Record<string, any>> };

    expect(out.campaigns[0]!.budget).toBe("Up to $1/day");
    expect(out.campaigns[0]!.volume).toBe("Up to 50 leads handled/week");
    expect(out.campaigns[0]!.maxBudgetDailyUsd).toBe(0);
  });

  it("says when no budget is set", async () => {
    routeApi({ "/v1/sales-funnel-campaigns": { salesFunnelCampaigns: [bliss] }, [capsPath]: { ...blissCaps, stated: false, maxBudget: null } });

    const out = (await handleToolCall("distribute_list_campaigns", {})) as { campaigns: Array<Record<string, any>> };

    expect(out.campaigns[0]!.budget).toBeNull();
    expect(out.campaigns[0]!.noBudgetSet).toBe(true);
  });

  it("fails loudly when a campaign's limits cannot be read", async () => {
    mockCallApi.mockImplementation(async (path: string) =>
      path.startsWith("/v1/sales-funnel-campaigns") ? { data: { salesFunnelCampaigns: [bliss] } } : { error: "Failed to read the sales funnel caps", status: 502 },
    );

    await expect(handleToolCall("distribute_list_campaigns", {})).rejects.toThrow("Failed to read the sales funnel caps");
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

  // A one-part campaign whose part serves `body` on GET /v1/campaigns/{id}/stats.
  const routeStats = (body: unknown) =>
    routeApi({
      "/v1/sales-funnel-campaigns/c1": { salesFunnelCampaign: { ...bliss, id: "c1", units: [bliss.units[0]] } },
      "/v1/public/channels": catalogue,
      "/v1/campaigns/u-email/stats": body,
    });
  const part = async () => {
    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as { results: Array<Record<string, any>> };
    return out.results[0]!;
  };

  it("leads with meetings, positive replies and delivery rate; failures come last", async () => {
    routeStats(stats());

    const out = (await part()) as Record<string, unknown>;
    const keys = Object.keys(out).filter((k) => k !== "bringsIn" && k !== "channel");

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
    routeStats(stats());

    const out = await part();

    for (const k of ["leadsServed", "leadsContacted", "emailsGenerated", "totalCostUsd", "recipientStats", "emailStats"]) {
      expect(out).toHaveProperty(k);
    }
    expect(out.recipientStats.bounced).toBe(13);
  });

  it("shows zeros plainly and invents no money figure", async () => {
    const zero = stats();
    zero.recipientStats = { ...zero.recipientStats, repliesPositive: 0, repliesDetail: { ...zero.recipientStats.repliesDetail, meetingBooked: 0 } };
    routeStats(zero);

    const out = await part();

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
    routeStats(served);

    const out = await part();

    expect(out.summary.deliveryRatePct).toBe(50);
    expect(out.headline).toContain("50% delivered (518 of 531)");
  });

  it("gives no delivery rate before anything is sent, and says why", async () => {
    const empty = stats();
    empty.headline = { ...empty.headline, deliveryRate: null, delivered: 0, sent: 0 };
    routeStats(empty);

    const out = await part();

    expect(out.summary.deliveryRatePct).toBeNull();
    expect(out.headline).toContain("no delivery rate yet (nothing sent)");
  });

  it("keeps a null served rate null when something was sent", async () => {
    const contradicted = stats();
    contradicted.headline = { ...contradicted.headline, deliveryRate: null };
    routeStats(contradicted);

    const out = await part();

    expect(out.summary.deliveryRatePct).toBeNull();
    expect(out.headline).toContain("delivery rate unknown");
  });

  it("reports a campaign by its name, part by part, each named by what it brings in and its channel", async () => {
    routeApi({
      "/v1/sales-funnel-campaigns/sfc-bliss": { salesFunnelCampaign: bliss },
      "/v1/public/channels": catalogue,
      "/v1/campaigns/u-email/stats": stats(),
      "/v1/campaigns/u-apollo/stats": stats({ campaignId: "u-apollo" }),
    });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "sfc-bliss", brandId: "b1" })) as Record<string, any>;

    expect(out.campaign).toEqual({ id: "sfc-bliss", name: "Bliss", status: "ongoing", brandId: "b1", offerId: "off1" });
    expect(out.results.map((r: any) => [r.bringsIn, r.channel])).toEqual([
      ["Positive reply", "Sales Cold Email Outreach"],
      ["Lead found", "Apollo Cold Filters"],
    ]);
    expect(out.headline).toMatch(/^Bliss \(running\)\. Positive reply \(Sales Cold Email Outreach\): 1 meetings booked/);
    expect(mockCallApi).toHaveBeenCalledWith("/v1/campaigns/u-email/stats?brandId=b1");
    // A part's own id and name never reach the customer as a campaign.
    const text = JSON.stringify(out);
    expect(text).not.toContain("u-email");
    expect(text).not.toContain("u-apollo");
    expect(text).not.toContain("NOVEMIQ (Positive replies");
  });

  it("finds a part stated under the old spelling of its step", async () => {
    routeApi({
      "/v1/sales-funnel-campaigns/c1": { salesFunnelCampaign: { ...bliss, id: "c1", units: [{ ...bliss.units[0], legKey: "start_to_conversation" }] } },
      "/v1/public/channels": catalogue,
      "/v1/campaigns/u-email/stats": stats(),
    });

    expect((await part()).bringsIn).toBe("Positive reply");
  });

  it("says plainly when nothing has run in the campaign yet", async () => {
    routeApi({ "/v1/sales-funnel-campaigns/c1": { salesFunnelCampaign: { ...bliss, id: "c1", status: "stopped", units: [] } }, "/v1/public/channels": catalogue });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as Record<string, any>;

    expect(out.headline).toBe("Bliss (stopped): nothing has run in this campaign yet.");
    expect(out.results).toEqual([]);
  });

  it("points an unknown id back to distribute_list_campaigns", async () => {
    mockCallApi.mockResolvedValue({ error: "Sales funnel campaign not found", status: 404 });

    await expect(handleToolCall("distribute_campaign_stats", { campaign_id: "old-id" })).rejects.toThrow(
      "No campaign old-id in this organization. Take the campaign id from distribute_list_campaigns.",
    );
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
    ["distribute_list_campaigns", { status: "ongoing" }, "/v1/sales-funnel-campaigns?status=ongoing", { salesFunnelCampaigns: [] }],
    ["distribute_campaign_stats", { campaign_id: "c1" }, "/v1/sales-funnel-campaigns/c1", { salesFunnelCampaign: { ...bliss, id: "c1", units: [] } }],
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
