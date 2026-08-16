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

describe("tool names", () => {
  it("exposes every tool under the distribute_ prefix", () => {
    for (const name of Object.keys(toolDefinitions)) {
      expect(name.startsWith("distribute_")).toBe(true);
    }
  });

  it("exposes no tool whose api-service endpoint no longer exists", () => {
    const names = Object.keys(toolDefinitions);
    expect(names).not.toContain("distribute_create_campaign");
    expect(names).not.toContain("distribute_resume_campaign");
    expect(names).not.toContain("distribute_campaign_debug");
  });
});

describe("distribute_list_workflows", () => {
  // Shape of one workflow as api-service GET /v1/workflows serves it today.
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
    featureSlug: "pr-cold-email-outreach",
    signature: "abc123",
    workflowDynastySignatureName: "sienna",
    status: "active",
    ...overrides,
  });

  it("calls GET /v1/workflows and returns mapped workflows", async () => {
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
          featureSlug: "pr-cold-email-outreach",
          signatureName: "sienna",
          status: "active",
        },
      ],
    });
  });

  it("passes human_id filter as humanId query param", async () => {
    mockCallApi.mockResolvedValue({
      data: { workflows: [] },
    });

    await handleToolCall("distribute_list_workflows", { human_id: "human-abc123" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows?humanId=human-abc123");
  });

  it("does not send a category filter — api-service does not support one", async () => {
    mockCallApi.mockResolvedValue({
      data: { workflows: [] },
    });

    await handleToolCall("distribute_list_workflows", { category: "sales" });

    expect(mockCallApi).toHaveBeenCalledWith("/v1/workflows");
  });

  it("prefers displayName, then the dynasty name, then the workflow name", async () => {
    mockCallApi.mockResolvedValue({
      data: {
        workflows: [makeWorkflow({ displayName: "Hormozi v1" })],
      },
    });

    const result = (await handleToolCall("distribute_list_workflows", {})) as {
      workflows: Array<Record<string, unknown>>;
    };

    expect(result.workflows[0]!.displayName).toBe("Hormozi v1");
  });

  it("throws on API error", async () => {
    mockCallApi.mockResolvedValue({ error: "Unauthorized" });

    await expect(handleToolCall("distribute_list_workflows", {})).rejects.toThrow("Unauthorized");
  });
});

describe("distribute_list_campaigns", () => {
  it("defaults to the all filter", async () => {
    mockCallApi.mockResolvedValue({ data: { campaigns: [] } });

    await handleToolCall("distribute_list_campaigns", {});

    expect(mockCallApi).toHaveBeenCalledWith("/v1/campaigns?status=all");
  });

  it("accepts the status vocabulary api-service serves", () => {
    const schema = toolDefinitions.distribute_list_campaigns.schema;
    expect(schema.safeParse({ status: "active" }).success).toBe(true);
    expect(schema.safeParse({ status: "stopped" }).success).toBe(true);
    expect(schema.safeParse({ status: "all" }).success).toBe(true);
    expect(schema.safeParse({ status: "ongoing" }).success).toBe(false);
  });
});

describe("distribute_status", () => {
  it("names the real API key page and the Bearer header when unconfigured", async () => {
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
    const joined = result.instructions.join("\n");
    expect(joined).toContain("https://dashboard.distribute.you/orgs/<orgId>/api-keys");
    expect(joined).toContain("Authorization: Bearer");
    // The retired brand's dashboard host, spelled indirectly so the repo carries no mention of it.
    expect(joined).not.toContain(`dashboard.${["mcp", "factory"].join("")}.org`);
  });
});
