import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  headApi: vi.fn(async () => ({ status: 200, etag: null })),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
  runWithApiKey: vi.fn((_k: unknown, fn: () => unknown) => fn()),
}));

import { handleToolCall, toolDefinitions } from "../src/tools/index.js";
import { callApi } from "../src/lib/api-client.js";
import { resetCatalog } from "../src/lib/gateway-catalog.js";

const mockCallApi = vi.mocked(callApi);

const CAPS = "/v1/brands/{brandId}/sales-funnels/{salesFunnelId}/campaigns/{salesFunnelCampaignId}/caps";
const doc = {
  data: {
    paths: {
      [CAPS]: { put: { tags: ["Billing"], summary: "Set a campaign's caps", operationId: "setCampaignCaps", security: [{ bearerAuth: [] }], responses: {} } },
      "/v1/sales-funnel-campaigns": { post: { tags: ["Campaigns"], summary: "Launch a campaign", operationId: "createCampaign", security: [{ bearerAuth: [] }], responses: {} } },
      "/v1/sales-funnel-campaigns/{id}": { patch: { tags: ["Campaigns"], summary: "Edit a campaign", operationId: "updateCampaign", security: [{ bearerAuth: [] }], responses: {} } },
    },
  },
  status: 200,
};
const capsPath = "/v1/brands/b1/sales-funnels/f1/campaigns/c1/caps";
const volume = { count: 1, period: "daily" };
const budget = { amountCents: 1000, period: "daily" };

beforeEach(() => {
  vi.clearAllMocks();
  resetCatalog();
});

describe("VOL-NEEDS-USD-1124: a max volume is written with a max budget in $", () => {
  it.each([
    ["PUT", capsPath, { maxBudget: null, maxVolume: volume }],
    ["POST", "/v1/sales-funnel-campaigns", { brandId: "b1", status: "stopped", brief: "x", maxVolume: volume }],
    ["PATCH", "/v1/sales-funnel-campaigns/c1", { maxVolume: volume }],
  ])("refuses %s %s stating a volume alone, nothing sent", async (method, path, body) => {
    mockCallApi.mockResolvedValueOnce(doc);
    await expect(handleToolCall("distribute_call_api", { method, path, body })).rejects.toThrow(/max_budget_required_with_max_volume/);
    expect(mockCallApi).toHaveBeenCalledTimes(1); // the catalogue read only
  });

  it("refuses a volume handed over as a JSON string body too", async () => {
    mockCallApi.mockResolvedValueOnce(doc);
    await expect(
      handleToolCall("distribute_call_api", { method: "PUT", path: capsPath, body: JSON.stringify({ maxBudget: null, maxVolume: volume }) }),
    ).rejects.toThrow(/max_budget_required_with_max_volume/);
  });

  it.each([
    ["volume with its budget", { maxBudget: budget, maxVolume: volume }],
    ["budget alone", { maxBudget: budget, maxVolume: null }],
    ["both cleared", { maxBudget: null, maxVolume: null }],
  ])("carries %s to the gateway unchanged", async (_label, body) => {
    mockCallApi.mockResolvedValueOnce(doc).mockResolvedValueOnce({ data: { ok: true }, status: 200 });
    await handleToolCall("distribute_call_api", { method: "PUT", path: capsPath, body });
    expect(mockCallApi).toHaveBeenLastCalledWith(capsPath, expect.objectContaining({ method: "PUT", body }));
  });

  it("no tool text says a max volume may stand alone", () => {
    const text = JSON.stringify(Object.values(toolDefinitions).map((t: any) => t.description));
    expect(text).not.toMatch(/max budget and\/or a max volume/);
    expect(text).toMatch(/max volume always comes with a max budget in \$/);
  });
});
