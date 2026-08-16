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
