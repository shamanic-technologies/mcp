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
 * The tools mirror what the CUSTOMER dashboard lets a person do. A customer funds
 * a sales funnel and picks audiences; operating a campaign is a staff action in
 * the admin console, and the customer dashboard has exactly one campaign write in
 * the whole app — at the end of onboarding, right after payment.
 *
 * So this server writes NOTHING. `create_campaign` could not have worked anyway:
 * onboarding funds a funnel in billing and activates the chosen audiences around
 * that call, and a tool doing neither lands a campaign with no money and no
 * audience.
 */
describe("the customer surface is read-only", () => {
  it("exposes no tool that creates or stops a campaign", () => {
    expect(toolDefinitions).not.toHaveProperty("distribute_create_campaign");
    expect(toolDefinitions).not.toHaveProperty("distribute_stop_campaign");
  });

  it("calls the gateway with no mutating verb", () => {
    const src = read("src/tools/index.ts");
    // The one POST left reads: an ICP suggestion computes an answer and stores
    // nothing on the account.
    const posts = src.match(/method: "(POST|PUT|PATCH|DELETE)"/g) ?? [];
    expect(posts).toEqual(['method: "POST"']);
    expect(src).toContain("/icp/suggest");
    expect(src).not.toContain("/v1/campaigns\", {");
  });

  it("describes no tool by an action it cannot perform", () => {
    for (const def of Object.values(toolDefinitions)) {
      expect(def.description).not.toMatch(/creat(e|ing) a campaign/i);
    }
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

/**
 * The name a client DISPLAYS for this server. It read the retired brand spaced
 * and title-cased, a variant the unspaced grep does not match, so it survived
 * the rename and was the first thing an MCP client showed the user. Checked
 * against the files that carry the name rather than the whole repo, so this
 * guard's own prose cannot fail it.
 */
describe("the displayed server name", () => {
  const named = ["src/index.ts", "shared/content/src/brand.ts", "shared/content/src/features.ts"];

  it("carries no spaced or title-cased variant of the retired brand", () => {
    for (const rel of named) {
      expect(read(rel)).not.toMatch(/mcp[ _-]?factory/i);
    }
  });

  it("introduces the server to a client as distribute", () => {
    expect(read("src/index.ts")).toContain('name: "distribute"');
  });
});

/**
 * A tool response has to fit in the client that asked for it.
 *
 * `list_campaigns` returned the gateway's row verbatim — 34 fields per campaign,
 * the whole offer among them — and one real account's 134 campaigns came to 322KB,
 * which an MCP client refuses outright. The tool returned nothing usable at all.
 * The projection below is 26KB for the same rows.
 */
describe("list_campaigns is a projection, not the row", () => {
  const src = read("src/tools/index.ts");

  it("does not hand back the gateway response verbatim", () => {
    const body = src.slice(
      src.indexOf("async function handleListCampaigns("),
      src.indexOf("async function handleCampaignStats("),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("campaigns.map(");
    expect(body).not.toMatch(/return result\.data;/);
  });

  it("omits the offer, the heaviest field and the one that answers nothing here", () => {
    const body = src.slice(
      src.indexOf("async function handleListCampaigns("),
      // Stop at the projection's closing brace: the doc comment BELOW this function
      // names the omitted field, and a slice that ran past it would fail on prose.
      src.indexOf("  };\n}", src.indexOf("async function handleListCampaigns(")),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("feature" + "Inputs");
  });

  it("filters on the vocabulary the platform stores", () => {
    // The field is optional, so the enum sits inside the wrapper.
    const schema = toolDefinitions.distribute_list_campaigns.schema;
    expect(schema.safeParse({ status: "ongoing" }).success).toBe(true);
    expect(schema.safeParse({ status: "active" }).success).toBe(false);
  });
});

/**
 * Opens are not a number this platform reports, anywhere — Apple Mail Privacy
 * Protection pre-fetches images, so the count measures the proxy. The gateway
 * still carries the field, and passing its response through carried it too.
 */
describe("campaign_stats reports no opens", () => {
  it("strips them at every depth", async () => {
    const { callApi } = await import("../src/lib/api-client.js");
    vi.mocked(callApi).mockResolvedValue({
      data: {
        campaignId: "c1",
        recipientStats: { sent: 10, opened: 3, clicked: 1 },
        emailStats: {
          sent: 10,
          opened: 3,
          stepStats: [{ step: 1, sent: 10, opened: 3, clicked: 1 }],
        },
      },
    });

    const out = (await handleToolCall("distribute_campaign_stats", { campaign_id: "c1" })) as {
      recipientStats: Record<string, unknown>;
      emailStats: { stepStats: Array<Record<string, unknown>> };
    };

    expect(JSON.stringify(out)).not.toContain("opened");
    expect(out.recipientStats.sent).toBe(10);
    expect(out.recipientStats.clicked).toBe(1);
    expect(out.emailStats.stepStats[0]!.sent).toBe(10);
  });
});

/**
 * The gateway's singular brand ICP path is registered, listed in the API
 * registry, and 404s on every call: it forwards to a brand-service route that does
 * not exist. The working one is per-brand.
 */
describe("suggest_icp calls the route that exists", () => {
  const src = read("src/tools/index.ts");

  it("does not call the dead singular path", () => {
    // Split so this guard's own prose cannot satisfy it.
    expect(src).not.toContain("/v1/brand/" + "icp-suggestion");
  });

  it("resolves the brand and posts to its own icp route", () => {
    expect(src).toContain("/icp/suggest");
    expect(src).toContain('callApi<{ brands: Array<{ id: string; domain?: string | null }> }>("/v1/brands")');
  });
});
