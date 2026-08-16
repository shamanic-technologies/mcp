import { z } from "zod";
import { getConfigStatus, callApi } from "../lib/api-client.js";

// Org API keys are minted in the distribute dashboard, one page per organization.
const API_KEYS_PAGE = "https://dashboard.distribute.you/orgs/<orgId>/api-keys";

// Tool definitions with Zod schemas
export const toolDefinitions = {
  distribute_status: {
    description: "Check distribute connection status and configuration",
    schema: z.object({}),
  },
  distribute_list_workflows: {
    description: "List all available workflows with their descriptions and categories. Includes styled workflows generated in the style of industry experts (e.g. Hormozi). Use the returned 'workflowDynastySlug' when a campaign has to name a workflow lineage.",
    schema: z.object({
      human_id: z.string().optional().describe("Filter by human expert ID (for styled workflows)"),
    }),
  },
  distribute_list_campaigns: {
    description: "List all your cold email campaigns",
    schema: z.object({
      status: z.enum(["active", "stopped", "all"]).optional().describe("Filter by campaign status"),
    }),
  },
  distribute_stop_campaign: {
    description: "Stop a running campaign",
    schema: z.object({
      campaign_id: z.string().describe("Campaign ID to stop"),
    }),
  },
  distribute_campaign_stats: {
    description: "Get statistics for a specific campaign",
    schema: z.object({
      campaign_id: z.string().describe("Campaign ID to get stats for"),
    }),
  },
  distribute_list_brands: {
    description: "List all your brands (companies/websites you promote through campaigns)",
    schema: z.object({}),
  },
  distribute_suggest_icp: {
    description:
      "Analyze a brand's website and suggest an Ideal Customer Profile (ICP). Use this when the user doesn't know who to target and wants AI-generated targeting suggestions.",
    schema: z.object({
      brand_url: z.string().describe("The brand/company URL to analyze for ICP extraction"),
    }),
  },
};

// Tool handlers
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "distribute_status":
      return handleStatus();

    case "distribute_list_workflows":
      return handleListWorkflows(args);

    case "distribute_list_campaigns":
      return handleListCampaigns(args);

    case "distribute_campaign_stats":
      return handleCampaignStats(args);

    case "distribute_stop_campaign":
      return handleStopCampaign(args);

    case "distribute_list_brands":
      return handleListBrands();

    case "distribute_suggest_icp":
      return handleSuggestIcp(args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Handler implementations
async function handleStatus() {
  const status = getConfigStatus();

  if (!status.configured) {
    return {
      status: "not_configured",
      message: "No distribute API key on this connection",
      instructions: [
        `1. Create an org API key at ${API_KEYS_PAGE} (replace <orgId> with your organization id)`,
        "2. Send it on every request to this server as the header: Authorization: Bearer <key>",
        "3. Reconnect your MCP client so the header is sent with the new session",
      ],
    };
  }

  // Check API connectivity
  const result = await callApi("/v1/me");

  if (result.error) {
    return {
      status: "error",
      message: result.error,
      apiUrl: status.apiUrl,
    };
  }

  return {
    status: "connected",
    apiUrl: status.apiUrl,
    user: result.data,
  };
}

async function handleListWorkflows(args: Record<string, unknown>) {
  const params = new URLSearchParams();
  if (args.human_id) params.set("humanId", args.human_id as string);

  const queryString = params.toString();
  const path = `/v1/workflows${queryString ? `?${queryString}` : ""}`;
  const result = await callApi<{ workflows: Array<Record<string, unknown>> }>(path);

  if (result.error) {
    throw new Error(result.error);
  }

  const workflows = (result.data as { workflows: Array<Record<string, unknown>> }).workflows;

  return {
    workflows: workflows.map((wf) => ({
      workflowSlug: wf.workflowSlug,
      workflowDynastySlug: wf.workflowDynastySlug,
      displayName: wf.displayName || wf.workflowDynastyName || wf.workflowName,
      version: wf.version,
      category: wf.category ?? null,
      channel: wf.channel ?? null,
      audienceType: wf.audienceType ?? null,
      featureSlug: wf.featureSlug ?? null,
      signatureName: wf.workflowDynastySignatureName ?? null,
      status: wf.status ?? null,
    })),
  };
}

async function handleListCampaigns(args: Record<string, unknown>) {
  const status = args.status || "all";
  const result = await callApi(`/v1/campaigns?status=${status}`);

  if (result.error) {
    throw new Error(result.error);
  }

  return result.data;
}

async function handleCampaignStats(args: Record<string, unknown>) {
  const result = await callApi(`/v1/campaigns/${args.campaign_id}/stats`);

  if (result.error) {
    throw new Error(result.error);
  }

  return result.data;
}

async function handleStopCampaign(args: Record<string, unknown>) {
  const result = await callApi(`/v1/campaigns/${args.campaign_id}/stop`, {
    method: "POST",
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return result.data;
}

async function handleListBrands() {
  const result = await callApi("/v1/brands");

  if (result.error) {
    throw new Error(result.error);
  }

  return result.data;
}

async function handleSuggestIcp(args: Record<string, unknown>) {
  const result = await callApi("/v1/brand/icp-suggestion", {
    method: "POST",
    body: {
      brandUrl: args.brand_url,
    },
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return result.data;
}
