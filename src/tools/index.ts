import { z } from "zod";
import { getConfigStatus, callApi, type ApiErrorBody } from "../lib/api-client.js";
import { forCustomer, withoutFields, OPEN_FIELDS } from "../lib/redact.js";
import {
  getCatalog,
  searchOperations,
  findOperation,
  matchPath,
  resolveSchema,
  isPlatformInternal,
  PLATFORM_INTERNAL_PATHS,
  type HttpMethod,
} from "../lib/gateway-catalog.js";

/**
 * A distribute.you key belongs to its USER, across every organization that user
 * is a member of (staff count as members of all). Each request acts in ONE
 * organization, named by a brand (`brandId`) or by the organization (`orgId`).
 * A user in a single organization names nothing; a user in several who names nothing
 * gets `400 org_target_required` from the gateway, with the list to choose from.
 * This server never picks one for them: it forwards what the caller named and
 * hands back the gateway's refusal whole.
 */
const TARGET_HINT =
  "Call distribute_status first to list brands, then pass brandId (and orgId if a brand sits in several orgs). " +
  "A user in a single organization can omit both.";

const targetShape = {
  brandId: z
    .string()
    .optional()
    .describe("Brand to act on (from distribute_status). Selects the organization holding it. Required when your key reaches several organizations, unless orgId is given."),
  orgId: z
    .string()
    .optional()
    .describe("Organization to act in (from distribute_status). Add it when a brand sits in several organizations, or to act in an organization without naming a brand."),
};

/** Append the caller's brand/org target to a gateway path, exactly as named. */
function withTarget(path: string, args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (typeof args.brandId === "string" && args.brandId) params.set("brandId", args.brandId);
  if (typeof args.orgId === "string" && args.orgId) params.set("orgId", args.orgId);
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`;
}

/**
 * Throw the gateway's refusal as-is. A body carrying a `code` (org_target_required,
 * brand_in_several_orgs, org_not_member, ...) is serialized whole, so the client
 * reads `code`, `message`, `fix` and `organizations` rather than a bare word.
 */
function failWith(result: { error?: string; errorBody?: ApiErrorBody }): never {
  if (result.errorBody && typeof result.errorBody.code === "string") {
    throw new Error(JSON.stringify(result.errorBody));
  }
  throw new Error(result.error ?? "Request failed");
}

/**
 * Same scope as the API (owner 2026-10-12): whatever a key can do on the public
 * gateway, it can do from here, and nothing more. Two layers:
 *
 * - CURATED tools for the frequent jobs (status, brands, campaigns and their
 *   results, leads, the emails we wrote and sent, one lead's conversation). They
 *   read, and shape the answer for an assistant.
 * - GENERIC tools over the gateway's own served catalogue (`distribute_find_api`,
 *   `distribute_describe_api`, `distribute_call_api`), so every customer route,
 *   writes included, is reachable without a tool written for it, and a route the
 *   gateway adds is reachable the day it ships. The gateway decides what the key
 *   may read or write; this server neither widens nor narrows it, except that our
 *   own internals (prompts, models, generation costs, the service registry) never
 *   leave through it.
 *
 * No curated tool creates or stops a campaign: the dashboard's only campaign
 * write sits at the end of onboarding, where billing is funded around it, and a
 * one-click tool for it would land a campaign with no money and no audience. A
 * customer who wants that route can still reach it through distribute_call_api,
 * exactly as through the API.
 */
// Tool definitions with Zod schemas
export const toolDefinitions = {
  distribute_status: {
    description:
      "Check the connection and say who the key belongs to: the user, and every organization the key reaches with its brands. " +
      "A key belongs to its USER and reaches every organization that user is a member of; it never belongs to a brand and never carries staff or beta powers. " +
      "Call this first: the other tools take a brandId (and an orgId when a brand sits in several organizations) from this list. " +
      "Keys are created and revoked at https://dashboard.distribute.you and sent as `Authorization: Bearer <key>`.",
    schema: z.object({}),
  },
  distribute_list_workflows: {
    description:
      "List all available workflows. Includes styled workflows written in the style of industry experts (e.g. Hormozi). " +
      TARGET_HINT,
    schema: z.object({
      human_id: z.string().optional().describe("Filter by human expert ID (for styled workflows)"),
      ...targetShape,
    }),
  },
  distribute_list_campaigns: {
    description:
      "List the campaigns of one brand or organization. Each campaign has a name, a status (`ongoing` = running, `stopped` = paused), " +
      "a type (`proactive`: it reaches out to new people on its own; `reactive`: it acts when something happens, such as a reply), " +
      "and its limits: `budget` and `volume` in words (\"Max $10/day\", \"Up to 50 leads handled/week\"), with what the current period used in `maxBudget` and `maxVolume`. " +
      "A campaign with no budget set spends nothing. Report each campaign by its name. " +
      TARGET_HINT,
    schema: z.object({
      ...targetShape,
      status: z.enum(["ongoing", "stopped", "all"]).optional().describe("Filter by campaign status: `ongoing` (running) or `stopped`. `all`, or no status, returns every campaign. Any other value is refused."),
    }),
  },
  distribute_campaign_stats: {
    description:
      "Get one campaign's results, by the campaign id from distribute_list_campaigns. A campaign runs as one; its results come in `results`, " +
      "one entry per thing it brings in (`bringsIn`, such as a positive reply or a lead found) with the channel doing it (`channel`). " +
      "Report the campaign by its name and never call an entry of `results` a campaign. " +
      "Report meetings, positive replies and delivery rate first, then volume and cost; " +
      "bounces and other failures last. Each entry is ordered that way: `headline`, then `summary`, then the raw figures, then `failureDetails`. " +
      "Show zeros plainly (0 meetings is still reported). " +
      TARGET_HINT,
    schema: z.object({
      campaign_id: z.string().describe("Campaign id, from distribute_list_campaigns"),
      ...targetShape,
    }),
  },
  distribute_list_brands: {
    description:
      "List the brands (companies/websites you promote through campaigns) of the targeted organization. " +
      "distribute_status already lists every organization with its brands; use this for the full brand records of the organization you target. " +
      TARGET_HINT,
    schema: z.object({ ...targetShape }),
  },
  distribute_suggest_icp: {
    description:
      "Analyze a brand's website and suggest an Ideal Customer Profile (ICP). Use this when the user doesn't know who to target and wants AI-generated targeting suggestions. Returns a description of the ideal customers to aim a campaign at. " +
      "Name the brand by brandId, or by brand_url (matched against the brands of the targeted organization). " +
      TARGET_HINT,
    schema: z.object({
      brand_url: z.string().optional().describe("The brand/company URL to analyze for ICP extraction. Optional when brandId is given."),
      ...targetShape,
    }),
  },
  distribute_list_leads: {
    description:
      "List the leads (prospects, people we found and contacted) of a brand, newest first, with where each one stands: " +
      "contacted, sent, delivered, clicked, replied (and how the reply was classified), bounced, unsubscribed, with dates. " +
      "Each lead carries an `id` to pass to distribute_get_lead for its emails and conversation. " +
      "Pages with `cursor`: pass the `nextCursor` of the previous page. `total` is the brand's lead count. " +
      TARGET_HINT,
    schema: z.object({
      ...targetShape,
      brandId: z.string().describe("Brand whose leads to list (from distribute_status)."),
      campaignId: z.string().optional().describe("Only leads of this campaign part (a lead's `campaignId`)."),
      limit: z.number().int().min(1).max(200).optional().describe("Leads per page (default 50, max 200)."),
      cursor: z.string().optional().describe("The `nextCursor` of the previous page."),
    }),
  },
  distribute_list_emails: {
    description:
      "List the cold emails we wrote and sent for a brand: for each prospect, the first email and every follow-up " +
      "(`subject`, then `sequence`: one entry per step with its `bodyText` and the days since the previous step), with who it went to " +
      "(lead name, title, company, `leadId`) and when it was written. Use it to answer \"what did you send for my brand\". " +
      "Whether each lead was actually sent, delivered or replied is on distribute_list_leads / distribute_get_lead. " +
      "Pages with `limit` and `offset`. " +
      TARGET_HINT,
    schema: z.object({
      ...targetShape,
      brandId: z.string().describe("Brand whose emails to list (from distribute_status)."),
      campaignId: z.string().optional().describe("Only the emails of this campaign part."),
      limit: z.number().int().min(1).max(100).optional().describe("Emails per page (default 20, max 100)."),
      offset: z.number().int().min(0).optional().describe("How many to skip (pagination)."),
    }),
  },
  distribute_get_lead: {
    description:
      "Everything about ONE lead in one call: who they are and where they stand (sent, delivered, replied...), the emails we wrote for them " +
      "(first email and follow-ups, subject and body), and the conversation (every message we sent and every reply they wrote, oldest first). " +
      "Take `lead_id` from distribute_list_leads (`id`). " +
      TARGET_HINT,
    schema: z.object({
      lead_id: z.string().describe("The lead's `id`, from distribute_list_leads."),
      ...targetShape,
    }),
  },
  distribute_find_api: {
    description:
      "Find how to do something in distribute.you when no other tool covers it. Searches every operation of the distribute.you API " +
      "(the same API and the same scope your key has: leads, emails, conversations, campaigns, budgets, offers, audiences, billing, CRM, stats...) " +
      "by what you want to do, in plain words (\"list the emails sent for my brand\", \"change the daily budget\", \"account balance\"). " +
      "Returns the best matching operations (method, path, summary, required parameters). Then call distribute_describe_api for the details " +
      "and distribute_call_api to run it. With no query, lists the areas of the API and how many operations each has.",
    schema: z.object({
      query: z.string().optional().describe("What you want to do, in plain words."),
      area: z.string().optional().describe("Restrict to one area (as listed with no query), e.g. Leads, Emails, Billing."),
      limit: z.number().int().min(1).max(50).optional().describe("How many matches (default 10)."),
    }),
  },
  distribute_describe_api: {
    description:
      "Read one distribute.you API operation in full before calling it: what it does, its path and query parameters (required or not), " +
      "and the JSON body it takes. Name it by `operationId`, or by `method` and `path`, as distribute_find_api returned them.",
    schema: z.object({
      operationId: z.string().optional().describe("Operation id from distribute_find_api."),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      path: z.string().optional().describe("Path template (/v1/leads/{id}) or a concrete path."),
    }),
  },
  distribute_call_api: {
    description:
      "Call any distribute.you API operation with your key, exactly as the API would answer it (same scope, same refusals). " +
      "Use it for anything the other tools do not cover; find the operation with distribute_find_api first. " +
      "`path` is the concrete path with its ids filled in (/v1/leads/123/timeline); query parameters go in `query`, a JSON body in `body`. " +
      "Writes (POST, PUT, PATCH, DELETE) change the account for real: say what you are about to change before calling. " +
      TARGET_HINT,
    schema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method of the operation."),
      path: z.string().describe("Concrete path, e.g. /v1/emails or /v1/leads/123/timeline."),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query parameters, e.g. {\"brandId\": \"...\", \"limit\": 20}."),
      body: z.unknown().optional().describe("JSON body for POST, PUT and PATCH."),
      ...targetShape,
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
      return handleListBrands(args);

    case "distribute_suggest_icp":
      return handleSuggestIcp(args);

    case "distribute_list_leads":
      return handleListLeads(args);

    case "distribute_list_emails":
      return handleListEmails(args);

    case "distribute_get_lead":
      return handleGetLead(args);

    case "distribute_find_api":
      return handleFindApi(args);

    case "distribute_describe_api":
      return handleDescribeApi(args);

    case "distribute_call_api":
      return handleCallApi(args);

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
      message: "No distribute.you API key on this session",
      instructions: [
        "1. Create a key at https://dashboard.distribute.you — open your organization, then API Key.",
        "2. Send it on every request as the header: Authorization: Bearer <your key>",
        "3. In an MCP client, put that header in this server's configuration and reconnect.",
      ],
    };
  }

  // Check API connectivity
  const result = await callApi<Record<string, unknown>>("/v1/me");

  if (result.error) {
    return {
      status: "error",
      message: result.error,
      apiUrl: status.apiUrl,
      // The gateway answers a revoked, deleted and mistyped key with the same
      // message, so this server cannot tell them apart either. Say so, rather
      // than let the caller guess one of the three.
      hint:
        "The API refused this key. A revoked, deleted or mistyped key all look the same from here. " +
        "Check the key at https://dashboard.distribute.you (organization, then API Key) and send it as `Authorization: Bearer <key>`.",
    };
  }

  // `/v1/me` answers with nothing named, for a key in any number of
  // organizations: it is how a multi-org caller learns its choices. Read only
  // what it serves; `/v1/brands` is not called here because, for a multi-org
  // key with no target, it is a 400.
  const me = result.data as Record<string, unknown>;
  const organizations = Array.isArray(me.organizations)
    ? (me.organizations as Array<Record<string, unknown>>).map((o) => ({
        id: o.id ?? null,
        name: o.name ?? null,
        brands: Array.isArray(o.brands)
          ? (o.brands as Array<Record<string, unknown>>).map((b) => ({
              id: b.id ?? null,
              name: b.name ?? null,
              domain: b.domain ?? null,
            }))
          : [],
      }))
    : null;

  return {
    status: "connected",
    summary: me.summary ?? null,
    user: me.user ?? null,
    organizations,
    organization: me.organization ?? null,
    keyScope: me.keyScope ?? null,
    howToTarget: TARGET_HINT,
    lookupErrors: Array.isArray(me.lookupErrors) && me.lookupErrors.length > 0 ? me.lookupErrors : undefined,
    apiUrl: status.apiUrl,
  };
}

async function handleListWorkflows(args: Record<string, unknown>) {
  // The gateway filters on humanId, featureSlug, featureDynastySlug, workflowSlug
  // and workflowDynastySlug — there is no category filter, so one sent here was
  // dropped on the floor and the caller got the unfiltered list back.
  const params = new URLSearchParams();
  if (args.human_id) params.set("humanId", args.human_id as string);

  const queryString = params.toString();
  const path = withTarget(`/v1/workflows${queryString ? `?${queryString}` : ""}`, args);
  const result = await callApi<{ workflows: Array<Record<string, unknown>> }>(path);

  if (result.error) failWith(result);

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


/**
 * A CAMPAIGN is what the customer launched and pays for (owner 2026-10-10): one brand, one offer,
 * one sales funnel, run or paused as one, with a max budget and a max volume. campaign-service
 * serves it (`/v1/sales-funnel-campaigns`); billing-service serves its limits and what the
 * current period consumed (`/v1/brands/:b/offers/:o/sales-funnels/:id/caps`).
 *
 * Inside, a campaign runs one PART per channel step (a `/v1/campaigns` row each). A customer never
 * reads a part as a campaign, never counts them as campaigns, never sees one named as one (owner
 * rule 2026-10-11). So this tool lists campaigns only, and `distribute_campaign_stats` reports a
 * campaign's results part by part, each named by what it brings in and the channel doing it.
 */
type FunnelUnit = { campaignId: string; featureSlug: string; legKey: string; status: string };
type FunnelCampaign = {
  id: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName: string;
  status: string;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
  units: FunnelUnit[];
};
type CapsBody = {
  stated: boolean;
  salesFunnelType?: string | null;
  salesFunnelTypeUnavailableReason?: string | null;
  maxBudget: {
    amountCents: string;
    period: string;
    dailyBudgetCents?: string | null;
    consumedCents: string | null;
    remainingCents: string | null;
    reached: boolean | null;
    consumedUnavailableReason: string | null;
  } | null;
  maxVolume: {
    count: number;
    period: string;
    unit: string;
    consumed: number | null;
    remaining: number | null;
    reached: boolean | null;
    consumedUnavailableReason: string | null;
  } | null;
};

/** A served cents string as dollars (formatting only). Null stays null; garbage is logged and null. */
function usd(cents: string | null | undefined): number | null {
  if (cents == null) return null;
  const n = Number(cents);
  if (!Number.isFinite(n)) {
    console.error("[mcp] unreadable cents from the API", { cents });
    return null;
  }
  return Math.round(n) / 100;
}

const PERIOD_SUFFIX: Record<string, string> = { daily: "/day", weekly: "/week", monthly: "/month", one_off: " in total" };
const periodSuffix = (p: string) => PERIOD_SUFFIX[p] ?? ` per ${p}`;

/** The dashboard's words for a campaign's limits: "Max $10/day" (proactive), "Up to $1/day" (reactive). */
function limitWords(type: string | null, caps: CapsBody): { budget: string | null; volume: string | null } {
  const prefix = type === "proactive" ? "Max " : type === "reactive" ? "Up to " : "";
  const b = caps.maxBudget;
  const v = caps.maxVolume;
  const amount = b ? usd(b.amountCents) : null;
  const unit = v ? (v.unit === "first_contacts" ? "new people" : v.unit === "prospects_handled" ? "leads handled" : v.unit.replace(/_/g, " ")) : "";
  return {
    budget: b && amount !== null ? `${prefix}$${Math.round(amount).toLocaleString("en-US")}${periodSuffix(b.period)}` : null,
    volume: v ? `${prefix}${v.count.toLocaleString("en-US")} ${unit}${periodSuffix(v.period)}` : null,
  };
}

async function funnelCampaignCaps(c: FunnelCampaign, args: Record<string, unknown>) {
  const path =
    `/v1/brands/${encodeURIComponent(c.brandId)}/offers/${encodeURIComponent(c.offerId)}` +
    `/sales-funnels/${encodeURIComponent(c.salesFunnelId)}/caps`;
  const result = await callApi<CapsBody>(withTarget(path, args));
  if (result.error) failWith(result);
  const caps = result.data as CapsBody;
  const type = caps.salesFunnelType === "proactive" || caps.salesFunnelType === "reactive" ? caps.salesFunnelType : null;
  if (!type) console.error("[mcp] no campaign type served", { id: c.id, reason: caps.salesFunnelTypeUnavailableReason ?? null });
  const words = limitWords(type, caps);
  return {
    type,
    budget: words.budget,
    volume: words.volume,
    // billing's own per-day figure (a reactive campaign's "up to" counts 0 a day: it spends only when something happens).
    maxBudgetDailyUsd: caps.maxBudget ? usd(caps.maxBudget.dailyBudgetCents) : null,
    maxBudget: caps.maxBudget
      ? {
          amountUsd: usd(caps.maxBudget.amountCents),
          period: caps.maxBudget.period,
          spentThisPeriodUsd: usd(caps.maxBudget.consumedCents),
          remainingUsd: usd(caps.maxBudget.remainingCents),
          reached: caps.maxBudget.reached,
          spentUnavailableReason: caps.maxBudget.consumedUnavailableReason,
        }
      : null,
    maxVolume: caps.maxVolume
      ? {
          count: caps.maxVolume.count,
          unit: caps.maxVolume.unit,
          period: caps.maxVolume.period,
          usedThisPeriod: caps.maxVolume.consumed,
          remaining: caps.maxVolume.remaining,
          reached: caps.maxVolume.reached,
          usedUnavailableReason: caps.maxVolume.consumedUnavailableReason,
        }
      : null,
    // No max budget stated = nothing funds it: it spends nothing until one is set.
    noBudgetSet: !caps.maxBudget,
  };
}

async function handleListCampaigns(args: Record<string, unknown>) {
  // The platform stores two statuses and refuses any other word with a 400, `all`
  // included: "every campaign" is asked for by sending no status at all.
  const status = args.status === "ongoing" || args.status === "stopped" ? args.status : undefined;
  const result = await callApi<{ salesFunnelCampaigns: FunnelCampaign[] }>(
    withTarget(status ? `/v1/sales-funnel-campaigns?status=${status}` : "/v1/sales-funnel-campaigns", args),
  );

  if (result.error) failWith(result);

  const listed = (result.data as { salesFunnelCampaigns: FunnelCampaign[] }).salesFunnelCampaigns;

  // A projection: name, status, limits. Parts are not listed (they are not campaigns).
  const campaigns = await Promise.all(
    listed.map(async (c) => ({
      id: c.id,
      name: c.salesFunnelName,
      status: c.status,
      stopReason: c.stopReason ?? null,
      brandId: c.brandId,
      offerId: c.offerId,
      ...(await funnelCampaignCaps(c, args)),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  );
  return { campaigns };
}

type PublicCatalogue = {
  channels?: Array<{ slug?: string; name?: string; stepTransitions?: Array<{ legKey?: string; to?: { label?: string } | null }> | null }> | null;
  legKeyCorrespondence?: Array<{ legacyLegKey?: string; legKey?: string }> | null;
};

/** What a part brings in and the channel doing it, read off the platform's public catalogue. */
function partNames(catalogue: PublicCatalogue, u: FunnelUnit): { bringsIn: string | null; channel: string | null } {
  const channel = (catalogue.channels ?? []).find((c) => c.slug === u.featureSlug);
  // An outbound step has two spellings while the platform migrates; the catalogue serves the pairs.
  const twins = new Set([u.legKey]);
  for (const p of catalogue.legKeyCorrespondence ?? []) {
    if (p.legacyLegKey === u.legKey && p.legKey) twins.add(p.legKey);
    if (p.legKey === u.legKey && p.legacyLegKey) twins.add(p.legacyLegKey);
  }
  const step = (channel?.stepTransitions ?? []).find((t) => t.legKey && twins.has(t.legKey));
  const names = { bringsIn: step?.to?.label ?? null, channel: channel?.name ?? null };
  if (!names.bringsIn || !names.channel) console.error("[mcp] a campaign part is not in the public catalogue", { featureSlug: u.featureSlug, legKey: u.legKey });
  return names;
}

async function handleCampaignStats(args: Record<string, unknown>) {
  const id = encodeURIComponent(String(args.campaign_id));
  const one = await callApi<{ salesFunnelCampaign: FunnelCampaign }>(withTarget(`/v1/sales-funnel-campaigns/${id}`, args));
  if (one.error) {
    if (one.status === 404) {
      throw new Error(
        `No campaign ${String(args.campaign_id)} in this organization. Take the campaign id from distribute_list_campaigns. ${TARGET_HINT}`,
      );
    }
    failWith(one);
  }
  const campaign = (one.data as { salesFunnelCampaign: FunnelCampaign }).salesFunnelCampaign;

  const catalogueRead = await callApi<PublicCatalogue>("/v1/public/channels");
  if (catalogueRead.error) failWith(catalogueRead);
  const catalogue = catalogueRead.data as PublicCatalogue;

  const results = await Promise.all(
    campaign.units.map(async (u) => {
      const stats = await callApi<Record<string, unknown>>(withTarget(`/v1/campaigns/${encodeURIComponent(u.campaignId)}/stats`, args));
      if (stats.error) failWith(stats);
      return { ...partNames(catalogue, u), ...resultsOf(stats.data) };
    }),
  );

  const state = campaign.status === "ongoing" ? "running" : campaign.status;
  const lines = results.map((r) => `${r.bringsIn ?? "Unnamed step"} (${r.channel ?? "unnamed channel"}): ${r.headline}`);
  return {
    headline:
      results.length === 0
        ? `${campaign.salesFunnelName} (${state}): nothing has run in this campaign yet.`
        : `${campaign.salesFunnelName} (${state}). ${lines.join(" ")}`,
    campaign: { id: campaign.id, name: campaign.salesFunnelName, status: campaign.status, brandId: campaign.brandId, offerId: campaign.offerId },
    // One entry per part of the campaign, each with what it brings in and the channel doing it.
    // Report the campaign by its name; a part is never a campaign of its own.
    results,
  };
}

/**
 * One part's results, success first. The gateway serves its own success-first `headline`
 * block; its figures are folded into `summary` so the one-line sentence keeps the `headline`
 * key. Key order IS the reading order: an assistant summarizing this JSON reports what it reads
 * first. Every other figure the gateway served stays, untouched, in between.
 */
function resultsOf(data: unknown) {
  // The part's own row id is not a campaign id a customer can use: dropped.
  const { headline: served, campaignId: _partId, ...raw } = withoutOpens(data) as Record<string, unknown>;
  const summary = successFirstSummary(raw, (served ?? {}) as Record<string, unknown>);
  return {
    headline: headlineOf(summary),
    summary,
    ...raw,
    failureDetails: failureDetailsOf(raw),
  };
}

type Summary = {
  meetingsBooked: number | null;
  positiveReplies: number | null;
  moneyEarnedUsd: null;
  roi: null;
  deliveryRatePct: number | null;
  delivered: number | null;
  sent: number | null;
  leadsContacted: number | null;
  emailsSent: number | null;
  costUsd: number | null;
  notServed: string[];
  unavailable: string[];
};

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * The owner's reading order: meetings and positive replies, money earned / ROI,
 * delivery rate, then volume and cost. Every figure is read from the gateway's
 * response. The delivery rate is the 0..1 ratio the API serves in its headline
 * (email-gateway's own figure), shown as a percent; null stays null. Money
 * earned and ROI are not served by the API, so they are null and listed in
 * `notServed` instead of guessed.
 */
function successFirstSummary(raw: Record<string, unknown>, served: Record<string, unknown>): Summary {
  const recipients = (raw.recipientStats ?? {}) as Record<string, unknown>;
  const detail = (recipients.repliesDetail ?? {}) as Record<string, unknown>;
  const emails = (raw.emailStats ?? {}) as Record<string, unknown>;
  const deliveryRate = num(served.deliveryRate);

  return {
    meetingsBooked: num(detail.meetingBooked),
    positiveReplies: num(recipients.repliesPositive),
    moneyEarnedUsd: null,
    roi: null,
    deliveryRatePct: deliveryRate === null ? null : Math.round(deliveryRate * 1000) / 10,
    delivered: num(served.delivered),
    sent: num(served.sent),
    leadsContacted: num(raw.leadsContacted),
    emailsSent: num(emails.sent),
    // The gateway's own headline cost (cents string, campaign-service's spend for the part).
    // `totalCostUsd` is only set when the email writer reports one, so reading it left the cost
    // out of nearly every headline while `totalCostInUsdCents` was served beside it.
    costUsd: usd(typeof served.costInUsdCents === "string" ? served.costInUsdCents : null),
    notServed: ["moneyEarnedUsd", "roi"],
    unavailable: Array.isArray(served.unavailable) ? (served.unavailable as string[]) : [],
  };
}

function headlineOf(s: Summary): string {
  const count = (n: number | null) => (n === null ? "unknown" : String(n));
  const delivery =
    s.deliveryRatePct !== null
      ? `${s.deliveryRatePct}% delivered (${s.delivered} of ${s.sent})`
      : s.sent === 0
        ? "no delivery rate yet (nothing sent)"
        : "delivery rate unknown";
  const cost = s.costUsd === null ? "" : `, $${s.costUsd.toFixed(2)} spent`;
  return (
    `${count(s.meetingsBooked)} meetings booked, ${count(s.positiveReplies)} positive replies, ${delivery}. ` +
    `${count(s.leadsContacted)} leads contacted, ${count(s.emailsSent)} emails sent${cost}.`
  );
}

/** Failures, last: the same numbers the raw figures carry, grouped where they belong. */
function failureDetailsOf(raw: Record<string, unknown>) {
  const recipients = (raw.recipientStats ?? {}) as Record<string, unknown>;
  const detail = (recipients.repliesDetail ?? {}) as Record<string, unknown>;
  const emails = (raw.emailStats ?? {}) as Record<string, unknown>;
  return {
    recipientsBounced: num(recipients.bounced),
    emailsBounced: num(emails.bounced),
    unsubscribed: num(recipients.unsubscribed),
    negativeReplies: num(recipients.repliesNegative),
    notInterested: num(detail.notInterested),
    wrongPerson: num(detail.wrongPerson),
  };
}

/**
 * Opens are not a number this platform reports, anywhere.
 *
 * Apple Mail Privacy Protection pre-fetches images, so an open count measures the
 * proxy rather than the person; the funnel we answer for is sent, click, positive
 * reply. The gateway still carries the field, and a tool that passes its response
 * through carries it too — which is how a retired metric reaches a customer inside
 * their MCP client. Stripped at every depth: the payload nests opens in
 * `recipientStats`, `emailStats`, and once per entry of `emailStats.stepStats`.
 */
function withoutOpens(value: unknown): unknown {
  return withoutFields(value, OPEN_FIELDS);
}

async function handleListBrands(args: Record<string, unknown>) {
  const result = await callApi(withTarget("/v1/brands", args));

  if (result.error) failWith(result);

  return result.data;
}

async function handleSuggestIcp(args: Record<string, unknown>) {
  // This used to call the gateway's singular brand ICP path. That route is registered
  // and listed in the API registry, and it 404s on every call — it forwards to a
  // brand-service route that does not exist. The working one is per-brand, and the
  // gateway already proxies it correctly.
  //
  // That route takes a brand id rather than a URL, so the brand is resolved here: the
  // caller names a site, which is what a person knows, and an id they would have to look
  // up first is a worse tool.
  //
  // A named brandId needs no lookup: `/v1/brands/{id}` selects its organization.
  let brandId = typeof args.brandId === "string" && args.brandId ? args.brandId : null;

  if (!brandId) {
    const brandUrl = String(args.brand_url ?? "");
    const wanted = hostnameOf(brandUrl);
    if (!wanted) throw new Error(`Name the brand: pass brandId, or brand_url as a URL (got: ${brandUrl || "nothing"}). ${TARGET_HINT}`);

    const brands = await callApi<{ brands: Array<{ id: string; domain?: string | null }> }>(withTarget("/v1/brands", args));
    if (brands.error) failWith(brands);

    const match = (brands.data as { brands: Array<{ id: string; domain?: string | null }> }).brands
      .find((b) => b.domain && hostnameOf(`https://${b.domain}`) === wanted);

    if (!match) {
      throw new Error(
        `No brand in the targeted organization matches ${wanted}. Call distribute_status to see every organization's brands, then pass brandId.`,
      );
    }
    brandId = match.id;
  }

  const result = await callApi(
    withTarget(`/v1/brands/${brandId}/icp/suggest`, { orgId: args.orgId }),
    { method: "POST", body: {} },
  );

  if (result.error) failWith(result);

  return result.data;
}

/** Bare hostname, `www.` dropped, so acme.com and https://www.acme.com/ are one brand. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// ── Leads, emails, one lead's conversation ─────────────────────────────────

/** Top-level lead fields that are our plumbing or a duplicate of the `person` summary. */
const LEAD_ROW_PLUMBING = new Set(["lead", "global", "sources", "statusDetails", "parentRunId", "runId", "orgId", "userId", "namespace", "apolloPersonId"]);

/**
 * A lead row as an assistant reads it: where the person stands (every status
 * field the API serves, including ones added later, passes through) and who
 * they are in a few fields. The full enrichment record stays on GET /v1/leads/{id}.
 */
function leadForAssistant(row: Record<string, unknown>) {
  const lead = (row.lead ?? null) as Record<string, unknown> | null;
  const org = (lead?.organization ?? null) as Record<string, unknown> | null;
  const rest = Object.fromEntries(Object.entries(row).filter(([k]) => !LEAD_ROW_PLUMBING.has(k)));
  return forCustomer({
    id: row.id,
    email: row.email,
    person: lead
      ? {
          name: lead.name ?? null,
          title: lead.currentTitle ?? null,
          headline: lead.headline ?? null,
          linkedinUrl: lead.linkedinUrl ?? null,
          city: lead.city ?? null,
          country: lead.country ?? null,
          company: org
            ? { name: org.name ?? null, domain: org.primaryDomain ?? null, industry: org.industry ?? null, employees: org.estimatedNumEmployees ?? null }
            : null,
        }
      : null,
    ...rest,
  });
}

/** Fields of a written email that are our plumbing (the HTML twin of `bodyText` included: same words, many more tokens). */
const EMAIL_PLUMBING = new Set(["bodyHtml", "runId", "generationRunId", "apolloEnrichmentId", "idempotencyKey", "orgId"]);

/**
 * One written email as an assistant reads it: subject, the steps with their
 * text, who it was for. Internals (prompt, model, tokens, generation costs) are
 * stripped by `forCustomer`; any other field the API adds later (a send status)
 * passes through.
 */
function emailForAssistant(email: Record<string, unknown>) {
  return forCustomer(withoutFields(email, EMAIL_PLUMBING));
}

async function handleListLeads(args: Record<string, unknown>) {
  const params = new URLSearchParams({ brandId: String(args.brandId) });
  if (args.campaignId) params.set("campaignId", String(args.campaignId));
  params.set("limit", String(args.limit ?? 50));
  if (args.cursor) params.set("cursor", String(args.cursor));
  const result = await callApi<{ leads: Array<Record<string, unknown>>; nextCursor?: string | null; total?: number }>(
    withTarget(`/v1/leads?${params}`, { orgId: args.orgId }),
  );
  if (result.error) failWith(result);
  const data = result.data as { leads: Array<Record<string, unknown>>; nextCursor?: string | null; total?: number };
  return {
    total: data.total ?? null,
    count: data.leads.length,
    nextCursor: data.nextCursor ?? null,
    leads: data.leads.map(leadForAssistant),
  };
}

async function handleListEmails(args: Record<string, unknown>) {
  const params = new URLSearchParams({ brandId: String(args.brandId) });
  if (args.campaignId) params.set("campaignId", String(args.campaignId));
  const limit = Number(args.limit ?? 20);
  const offset = Number(args.offset ?? 0);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const result = await callApi<{ emails: Array<Record<string, unknown>> }>(withTarget(`/v1/emails?${params}`, { orgId: args.orgId }));
  if (result.error) failWith(result);
  const emails = (result.data as { emails: Array<Record<string, unknown>> }).emails;
  return {
    count: emails.length,
    // A full page means there may be more: ask again from the next offset.
    nextOffset: emails.length === limit ? offset + limit : null,
    emails: emails.map(emailForAssistant),
  };
}

async function handleGetLead(args: Record<string, unknown>) {
  const id = encodeURIComponent(String(args.lead_id));
  const one = await callApi<{ leadDetail: Record<string, unknown> }>(withTarget(`/v1/leads/${id}`, args));
  if (one.error) {
    if (one.status === 404) throw new Error(`No lead ${String(args.lead_id)} here. Take the lead id from distribute_list_leads (\`id\`). ${TARGET_HINT}`);
    failWith(one);
  }
  const row = (one.data as { leadDetail: Record<string, unknown> }).leadDetail;
  const campaignId = typeof row.campaignId === "string" ? row.campaignId : null;
  const leadId = typeof row.leadId === "string" ? row.leadId : null;
  const email = typeof row.email === "string" ? row.email : null;
  const brandIds = Array.isArray(row.brandIds) ? (row.brandIds as string[]) : [];
  const brandId = (typeof args.brandId === "string" && args.brandId) || brandIds[0] || null;

  // The two reads are independent, and a refusal of one must not hide the other:
  // each is reported in place, the refusal body whole.
  const [written, conversation] = await Promise.all([
    leadId
      ? callApi<{ generation: Record<string, unknown> | null }>(
          withTarget(
            `/v1/emails/by-lead/${encodeURIComponent(leadId)}?${new URLSearchParams({
              ...(brandId ? { brandId } : {}),
              ...(campaignId ? { campaignId } : {}),
            })}`,
            { orgId: args.orgId },
          ),
        )
      : Promise.resolve({ error: "This lead carries no leadId", status: undefined, errorBody: undefined, data: undefined }),
    campaignId && email
      ? callApi<{ conversation?: Record<string, unknown> }>(
          withTarget(`/v1/conversations?${new URLSearchParams({ campaign_id: campaignId, email })}`, {
            orgId: args.orgId,
            ...(brandId ? { brandId } : {}),
          }),
        )
      : Promise.resolve({ error: "This lead carries no campaign or email address", status: undefined, errorBody: undefined, data: undefined }),
  ]);

  const generation = written.error ? null : ((written.data as { generation: Record<string, unknown> | null }).generation ?? null);
  return {
    lead: leadForAssistant(row),
    emailsWritten: generation ? emailForAssistant(generation) : null,
    ...(written.error ? { emailsWrittenUnavailable: written.errorBody ?? { error: written.error, status: written.status ?? null } } : {}),
    conversation: conversation.error ? null : forCustomer((conversation.data as { conversation?: unknown }).conversation ?? conversation.data),
    ...(conversation.error
      ? { conversationUnavailable: conversation.errorBody ?? { error: conversation.error, status: conversation.status ?? null } }
      : {}),
  };
}

// ── The whole API, by intent ─────────────────────────────────────────────────

async function handleFindApi(args: Record<string, unknown>) {
  const { operations } = await getCatalog();
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const area = typeof args.area === "string" && args.area ? args.area : undefined;
  if (!query) {
    const counts = new Map<string, number>();
    for (const op of operations) {
      if (area && (op.tag ?? "").toLowerCase() !== area.toLowerCase()) continue;
      counts.set(op.tag ?? "Other", (counts.get(op.tag ?? "Other") ?? 0) + 1);
    }
    if (area) {
      return {
        area,
        operations: operations
          .filter((o) => (o.tag ?? "").toLowerCase() === area.toLowerCase())
          .map((o) => ({ operationId: o.operationId, method: o.method, path: o.path, summary: o.summary })),
      };
    }
    return {
      totalOperations: operations.length,
      areas: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ area: name, operations: count })),
      next: "Ask again with a query in plain words, or with an area to list its operations.",
    };
  }
  const matches = searchOperations(operations, query, Number(args.limit ?? 10), area);
  return {
    query,
    matches,
    next:
      matches.length === 0
        ? "Nothing matched. Try other words, or call with no query to see the areas of the API."
        : "Call distribute_describe_api with an operationId for its parameters and body, then distribute_call_api to run it.",
  };
}

async function handleDescribeApi(args: Record<string, unknown>) {
  const { operations, components } = await getCatalog();
  const op = findOperation(operations, {
    operationId: typeof args.operationId === "string" ? args.operationId : undefined,
    method: typeof args.method === "string" ? args.method : undefined,
    path: typeof args.path === "string" ? args.path.split("?")[0] : undefined,
  });
  if (!op) {
    throw new Error("No such operation. Name it by operationId, or by method and path, as distribute_find_api returned them.");
  }
  return {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    area: op.tag,
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated,
    parameters: op.params,
    body: op.hasBody ? resolveSchema(op.bodySchema, components) : null,
    howToCall: {
      tool: "distribute_call_api",
      method: op.method,
      path: `${op.path}  (fill each {param} with its value)`,
      targeting: TARGET_HINT,
    },
  };
}

/** Above this, a response is not handed back whole: an assistant's context is not a file system. */
export const MAX_RESULT_CHARS = 200_000;

async function handleCallApi(args: Record<string, unknown>) {
  const method = String(args.method).toUpperCase() as HttpMethod;
  const rawPath = String(args.path ?? "").trim();
  if (!rawPath.startsWith("/")) throw new Error(`path must start with "/" (got: ${rawPath || "nothing"}), e.g. /v1/emails`);
  const [pathOnly, inlineQuery] = rawPath.split("?", 2) as [string, string | undefined];
  if (pathOnly.includes("..")) throw new Error("path may not contain '..'");

  // A path this server will not carry, whatever the gateway answers: our internals.
  if (isPlatformInternal(pathOnly)) {
    throw new Error(`${pathOnly} is not available through this server (${PLATFORM_INTERNAL_PATHS.join(", ")} are distribute.you internals).`);
  }

  // Only operations of the gateway's served customer catalogue. A staff route is
  // absent from it, so it cannot be reached through here.
  const { operations } = await getCatalog();
  const match = matchPath(operations, method, pathOnly);
  if (!match) {
    const near = searchOperations(operations, pathOnly.replace(/[/{}-]/g, " "), 5);
    throw new Error(
      JSON.stringify({
        error: `${method} ${pathOnly} is not an operation of the distribute.you API.`,
        didYouMean: near.map((h) => `${h.method} ${h.path}`),
        fix: "Find the operation with distribute_find_api.",
      }),
    );
  }
  if (!match.operation) {
    throw new Error(
      JSON.stringify({
        error: `${pathOnly} exists, but not with ${method}.`,
        methods: match.otherMethods,
      }),
    );
  }

  const params = new URLSearchParams(inlineQuery ?? "");
  const query = (args.query ?? {}) as Record<string, string | number | boolean>;
  for (const [k, v] of Object.entries(query)) params.set(k, String(v));
  if (typeof args.brandId === "string" && args.brandId && !params.has("brandId") && !pathOnly.includes(args.brandId)) {
    params.set("brandId", args.brandId);
  }
  if (typeof args.orgId === "string" && args.orgId && !params.has("orgId")) params.set("orgId", args.orgId);
  const qs = params.toString();

  const result = await callApi<unknown>(`${pathOnly}${qs ? `?${qs}` : ""}`, {
    method,
    body: method === "GET" || method === "DELETE" ? undefined : (args.body ?? {}),
  });
  if (result.error) {
    throw new Error(JSON.stringify({ status: result.status ?? null, ...(result.errorBody ?? { error: result.error }) }));
  }

  const data = forCustomer(result.data);
  const text = JSON.stringify(data);
  if (text.length > MAX_RESULT_CHARS) {
    return {
      operation: `${match.operation.method} ${match.operation.path}`,
      status: result.status ?? null,
      truncated: true,
      sizeChars: text.length,
      fix: "The answer is too large to hand back whole. Ask for fewer rows (limit / offset / cursor, see distribute_describe_api).",
      preview: text.slice(0, 20_000),
    };
  }
  return { operation: `${match.operation.method} ${match.operation.path}`, status: result.status ?? null, data };
}
