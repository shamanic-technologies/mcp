import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

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
const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");
// The retired brand, spelled indirectly so the repo itself carries no mention of it.
const RETIRED_BRAND = ["mcp", "factory"].join("");

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The key a customer creates in the dashboard is a Bearer token. api-service
 * reads `X-API-Key` on a SEPARATE auth path reserved for the platform admin
 * key, and answers a customer key sent that way with `401 Invalid admin key` —
 * so this server forwarded every call under a header that could only ever be
 * rejected, and all ten tools failed on their first call.
 */
describe("the gateway is called with a Bearer token", () => {
  const client = read("src/lib/api-client.ts");

  it("sends Authorization: Bearer, never the admin-key header", () => {
    expect(client).toContain("Authorization: `Bearer ${key}`");
    expect(client).not.toContain("X-API-Key");
  });

  it("defaults to the live gateway, not a retired domain", () => {
    expect(client).toContain("https://api.distribute.you");
    expect(client.toLowerCase()).not.toContain(RETIRED_BRAND);
  });
});

/**
 * A tool whose endpoint does not exist can only fail, so it is not shipped.
 * Verified against the deployed api-service contract: `/v1/campaigns/{id}/debug`
 * and `/v1/campaigns/{id}/resume` are not routes the gateway serves.
 */
describe("only tools the gateway can actually serve", () => {
  it("exposes no campaign debug or resume tool", () => {
    expect(toolDefinitions).not.toHaveProperty("distribute_campaign_debug");
    expect(toolDefinitions).not.toHaveProperty("distribute_resume_campaign");
  });

  it("names every tool for the product, not the retired brand", () => {
    const names = Object.keys(toolDefinitions);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name.startsWith("distribute_")).toBe(true);
    }
  });
});

/**
 * The create body used to be flat — `workflowName`, `brandUrl`, and the offer
 * levers at top level — which matched no field the gateway declares. It takes
 * dynasty slugs, a `brandUrls` array, and the offer as opaque `featureInputs`;
 * a sales campaign must also state the funnel it sells through, because that is
 * what it gets paced and priced on.
 */
describe("create_campaign speaks the gateway's body", () => {
  const validArgs = {
    name: "Q3 outreach",
    workflow_dynasty_slug: "sales-email-cold-outreach-sienna",
    feature_dynasty_slug: "sales-cold-email-outreach",
    funnel_key: "reply_meeting",
    brand_url: "https://acme.com",
    target_audience: "CTOs at SaaS startups",
    target_outcome: "Book sales demos",
    value_for_target: "Analytics at startup pricing",
    urgency: "Closes in 30 days",
    scarcity: "10 spots",
    risk_reversal: "Two-week trial",
    social_proof: "500 companies onboarded",
    max_daily_budget_usd: 50,
  };

  it("sends dynasty slugs, a brand array, the funnel and opaque feature inputs", async () => {
    mockCallApi.mockResolvedValue({ data: { campaign: { id: "c1" } } });

    await handleToolCall("distribute_create_campaign", validArgs);

    const [path, options] = mockCallApi.mock.calls[0]!;
    expect(path).toBe("/v1/campaigns");

    const body = (options as { body: Record<string, unknown> }).body;
    expect(body.workflowDynastySlug).toBe("sales-email-cold-outreach-sienna");
    expect(body.featureDynastySlug).toBe("sales-cold-email-outreach");
    expect(body.funnelKey).toBe("reply_meeting");
    expect(body.brandUrls).toEqual(["https://acme.com"]);
    expect(body.featureInputs).toEqual({
      targetAudience: "CTOs at SaaS startups",
      targetOutcome: "Book sales demos",
      valueForTarget: "Analytics at startup pricing",
      urgency: "Closes in 30 days",
      scarcity: "10 spots",
      riskReversal: "Two-week trial",
      socialProof: "500 companies onboarded",
    });

    // The shapes the gateway does not declare must be gone.
    expect(body).not.toHaveProperty("workflowName");
    expect(body).not.toHaveProperty("brandUrl");
    expect(body).not.toHaveProperty("targetAudience");
  });

  it("still refuses a campaign with no budget at all", async () => {
    await expect(
      handleToolCall("distribute_create_campaign", {
        ...validArgs,
        max_daily_budget_usd: undefined,
      }),
    ).rejects.toThrow(/budget is required/);
  });

  it("requires the sales funnel, so a campaign cannot be created unpriced", () => {
    const schema = toolDefinitions.distribute_create_campaign.schema;
    const parsed = schema.safeParse({ ...validArgs, funnel_key: undefined });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The first thing an unconfigured server tells a person has to be somewhere
 * they can actually go. It used to name the retired brand's dashboard host, which
 * stopped resolving when that brand was retired.
 */
describe("the unconfigured message points at the real key page", () => {
  it("names the live dashboard and the header to send", async () => {
    const { getConfigStatus } = await import("../src/lib/api-client.js");
    vi.mocked(getConfigStatus).mockReturnValueOnce({
      configured: false,
      apiUrl: "https://api.distribute.you",
    });

    const result = (await handleToolCall("distribute_status", {})) as {
      status: string;
      instructions: string[];
    };

    expect(result.status).toBe("not_configured");
    const text = result.instructions.join(" ");
    expect(text).toContain("dashboard.distribute.you");
    expect(text).toContain("Authorization: Bearer");
    expect(text.toLowerCase()).not.toContain(RETIRED_BRAND);
  });
});
