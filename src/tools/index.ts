import { z } from "zod";
import { getConfigStatus, callApi } from "../lib/api-client.js";

/**
 * The tools mirror what the CUSTOMER dashboard lets a person do, and nothing more.
 *
 * A customer funds a sales funnel and chooses audiences; they do not operate
 * campaigns. Creating and stopping one is a STAFF action in the admin console —
 * the customer dashboard has exactly one campaign write in the whole app, at the
 * end of onboarding, right after payment. `create_campaign` and `stop_campaign`
 * used to be exposed here, which handed a customer over the API the affordance
 * the product deliberately does not give them in the UI.
 *
 * `create_campaign` could not have produced a working campaign anyway: onboarding
 * funds a funnel in billing and activates the chosen audiences around that call,
 * and a tool doing neither lands a campaign with no money and no audience — the
 * half-state the dashboard's own blocker exists to catch.
 *
 * So: read everything, write nothing. Adding a write here means the customer
 * dashboard grew one first.
 */
// Tool definitions with Zod schemas
export const toolDefinitions = {
  distribute_status: {
    description: "Check the distribute connection status and configuration",
    schema: z.object({}),
  },
  distribute_list_workflows: {
    description: "List all available workflows. Includes styled workflows written in the style of industry experts (e.g. Hormozi).",
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
      "Analyze a brand's website and suggest an Ideal Customer Profile (ICP). Use this when the user doesn't know who to target and wants AI-generated targeting suggestions. Returns a description of the ideal customers to aim a campaign at.",
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
      message: "No distribute API key on this session",
      instructions: [
        "1. Create a key at https://dashboard.distribute.you — open your organization, then API Key.",
        "2. Send it on every request as the header: Authorization: Bearer <your key>",
        "3. In an MCP client, put that header in this server's configuration and reconnect.",
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
  // The gateway filters on humanId, featureSlug, featureDynastySlug, workflowSlug
  // and workflowDynastySlug — there is no category filter, so one sent here was
  // dropped on the floor and the caller got the unfiltered list back.
  const params = new URLSearchParams();
  if (args.human_id) params.set("humanId", args.human_id as string);

  const queryString = params.toString();
  const path = `/v1/workflows${queryString ? `?${queryString}` : ""}`;
  const result = await callApi<{ workflows: Array<Record<string, unknown>> }>(path);

  if (result.error) {
    throw new Error(result.error);
  }

  const workflows = (result.data as { workflows: Array<Record<string, unknown>> }).workflows;

  // Field names as the deployed gateway serves them. This used to read `name`,
  // `description`, `signatureName` and `styleName`, none of which are in the
  // response any more, so every workflow came back as a row of undefined —
  // including the slug a campaign has to name.
  return {
    workflows: workflows.map((wf) => ({
      workflowSlug: wf.workflowSlug,
      workflowDynastySlug: wf.workflowDynastySlug,
      displayName: wf.displayName || wf.workflowDynastyName || wf.workflowName,
      version: wf.version ?? null,
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
