import { z } from "zod";
import { getConfigStatus, callApi } from "../lib/api-client.js";

// Tool definitions with Zod schemas
export const toolDefinitions = {
  distribute_status: {
    description: "Check the distribute connection status and configuration",
    schema: z.object({}),
  },
  distribute_list_workflows: {
    description: "List all available workflows. Includes styled workflows written in the style of industry experts (e.g. Hormozi). Use the returned 'workflowDynastySlug' as the workflow_dynasty_slug when creating a campaign.",
    schema: z.object({
      human_id: z.string().optional().describe("Filter by human expert ID (for styled workflows)"),
    }),
  },
  distribute_create_campaign: {
    description: "Create and immediately start a cold email campaign. Provide a URL, describe your target audience in plain text, name the sales funnel it sells through, and set a budget. The system finds matching leads automatically.",
    schema: z.object({
      name: z.string().describe("Campaign name"),
      workflow_dynasty_slug: z.string().describe("Workflow lineage slug (e.g. 'sales-email-cold-outreach-sienna'). Use distribute_list_workflows to see what is available; the latest version is resolved for you."),
      feature_dynasty_slug: z.string().describe("Feature lineage slug the campaign runs under (e.g. 'sales-cold-email-outreach')."),
      funnel_key: z
        .enum(["reply_meeting", "visit_meeting", "visit_signup", "visit_form"])
        .describe("The sales funnel this campaign sells through. It is what the campaign is paced and priced on, so a sales campaign cannot be created without one."),
      brand_url: z.string().describe("Your brand/company URL to promote"),
      target_audience: z.string().describe("Plain text description of your ideal customers (e.g. 'CTOs at SaaS startups with 10-50 employees in the US')"),
      target_outcome: z.string().describe("What you want to achieve with this campaign (e.g. 'Book sales demos', 'Recruit community ambassadors', 'Get press coverage')"),
      value_for_target: z.string().describe("What the target audience gains from responding (e.g. 'Access to an enterprise-grade analytics platform at startup pricing')"),
      urgency: z.string().describe("Time-based constraint that motivates action now (e.g. 'Recruitment closes in 30 days')"),
      scarcity: z.string().describe("Supply-based constraint on availability (e.g. 'Only 10 spots available worldwide')"),
      risk_reversal: z.string().describe("Guarantee or safety net that removes risk for the prospect (e.g. 'Free trial for 2 weeks, no commitment')"),
      social_proof: z.string().describe("Evidence of credibility and traction (e.g. '500+ companies already onboarded')"),
      max_daily_budget_usd: z.number().optional().describe("Maximum daily spend in USD (at least one budget required)"),
      max_weekly_budget_usd: z.number().optional().describe("Maximum weekly spend in USD"),
      max_monthly_budget_usd: z.number().optional().describe("Maximum monthly spend in USD"),
      max_total_budget_usd: z.number().optional().describe("Maximum total spend in USD (campaign stops permanently when reached)"),
      max_leads: z.number().optional().describe("Maximum number of leads to contact (campaign stops permanently when reached)"),
      end_date: z.string().optional().describe("Optional campaign end date (ISO format)"),
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
      "Analyze a brand's website and suggest an Ideal Customer Profile (ICP). Use this when the user doesn't know who to target and wants AI-generated targeting suggestions. Returns a description of ideal customers that can be used as the target_audience in distribute_create_campaign.",
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

    case "distribute_create_campaign":
      return handleCreateCampaign(args);

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

async function handleCreateCampaign(args: Record<string, unknown>) {
  // Validate at least one budget is provided (max_leads is optional, not a replacement for budget)
  if (!args.max_daily_budget_usd && !args.max_weekly_budget_usd && !args.max_monthly_budget_usd && !args.max_total_budget_usd) {
    throw new Error("At least one budget is required (max_daily_budget_usd, max_weekly_budget_usd, max_monthly_budget_usd, or max_total_budget_usd)");
  }

  // The gateway takes the offer as opaque `featureInputs` (validated by
  // key-presence against features-service, never inspected by api-service), the
  // brand as a `brandUrls` array, and the workflow/feature as dynasty slugs so
  // the latest version is resolved for us. The flat body this used to send —
  // `workflowName`, `brandUrl`, and the levers at top level — matched no field
  // the gateway declares, so every create was refused.
  const result = await callApi("/v1/campaigns", {
    method: "POST",
    body: {
      name: args.name,
      workflowDynastySlug: args.workflow_dynasty_slug,
      featureDynastySlug: args.feature_dynasty_slug,
      funnelKey: args.funnel_key,
      brandUrls: [args.brand_url],
      featureInputs: {
        targetAudience: args.target_audience,
        targetOutcome: args.target_outcome,
        valueForTarget: args.value_for_target,
        urgency: args.urgency,
        scarcity: args.scarcity,
        riskReversal: args.risk_reversal,
        socialProof: args.social_proof,
      },
      maxBudgetDailyUsd: args.max_daily_budget_usd,
      maxBudgetWeeklyUsd: args.max_weekly_budget_usd,
      maxBudgetMonthlyUsd: args.max_monthly_budget_usd,
      maxBudgetTotalUsd: args.max_total_budget_usd,
      maxLeads: args.max_leads,
      endDate: args.end_date,
    },
  });

  if (result.error) {
    throw new Error(result.error);
  }

  return result.data;
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
