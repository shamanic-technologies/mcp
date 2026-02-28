import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api-client module before importing tools
vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.mcpfactory.org" })),
  callApi: vi.fn(),
  setApiKey: vi.fn(),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
}));

import { handleToolCall } from "../src/tools/index.js";
import { callApi } from "../src/lib/api-client.js";

const mockCallApi = vi.mocked(callApi);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mcpfactory_list_workflows", () => {
  const makeWorkflow = (overrides: Record<string, unknown> = {}) => ({
    id: "wf-1",
    appId: "mcpfactory",
    orgId: "org-1",
    name: "sales-email-cold-outreach-sienna",
    displayName: null,
    description: "Cold email outreach workflow",
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    signatureName: "sienna",
    humanId: null,
    styleName: null,
    brandId: null,
    campaignId: null,
    ...overrides,
  });

  it("calls GET /v1/workflows and returns mapped workflows", async () => {
    mockCallApi.mockResolvedValue({
      data: {
        workflows: [makeWorkflow()],
      },
    });

    const result = await handleToolCall("mcpfactory_list_workflows", {});

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows");
    expect(result).toEqual({
      workflows: [
        {
          name: "sales-email-cold-outreach-sienna",
          displayName: "sales-email-cold-outreach-sienna",
          description: "Cold email outreach workflow",
          category: "sales",
          channel: "email",
          audienceType: "cold-outreach",
          signatureName: "sienna",
          humanId: null,
          styleName: null,
        },
      ],
    });
  });

  it("passes category filter as query param", async () => {
    mockCallApi.mockResolvedValue({
      data: { workflows: [] },
    });

    await handleToolCall("mcpfactory_list_workflows", { category: "sales" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows?category=sales");
  });

  it("passes human_id filter as humanId query param", async () => {
    mockCallApi.mockResolvedValue({
      data: { workflows: [] },
    });

    await handleToolCall("mcpfactory_list_workflows", { human_id: "human-abc123" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows?humanId=human-abc123");
  });

  it("passes both category and human_id filters", async () => {
    mockCallApi.mockResolvedValue({
      data: { workflows: [] },
    });

    await handleToolCall("mcpfactory_list_workflows", { category: "sales", human_id: "human-abc123" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows?category=sales&humanId=human-abc123");
  });

  it("surfaces humanId and styleName for styled workflows", async () => {
    mockCallApi.mockResolvedValue({
      data: {
        workflows: [
          makeWorkflow({
            name: "sales-email-cold-outreach-hormozi-v1",
            displayName: "Hormozi v1",
            signatureName: "hormozi-v1",
            humanId: "human-abc123",
            styleName: "hormozi",
          }),
        ],
      },
    });

    const result = (await handleToolCall("mcpfactory_list_workflows", {})) as {
      workflows: Array<Record<string, unknown>>;
    };

    expect(result.workflows[0]).toEqual({
      name: "sales-email-cold-outreach-hormozi-v1",
      displayName: "Hormozi v1",
      description: "Cold email outreach workflow",
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      signatureName: "hormozi-v1",
      humanId: "human-abc123",
      styleName: "hormozi",
    });
  });

  it("uses name as displayName fallback when displayName is null", async () => {
    mockCallApi.mockResolvedValue({
      data: {
        workflows: [makeWorkflow({ displayName: null })],
      },
    });

    const result = (await handleToolCall("mcpfactory_list_workflows", {})) as {
      workflows: Array<Record<string, unknown>>;
    };

    expect(result.workflows[0]!.displayName).toBe("sales-email-cold-outreach-sienna");
  });

  it("throws on API error", async () => {
    mockCallApi.mockResolvedValue({ error: "Unauthorized" });

    await expect(handleToolCall("mcpfactory_list_workflows", {})).rejects.toThrow("Unauthorized");
  });
});
