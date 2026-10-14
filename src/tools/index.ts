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
  type CatalogOperation,
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
 * An id the caller may send under the camelCase name every other tool and the API use, or under
 * the older snake_case name existing callers send (2026-10-14: an agent's first call failed on
 * `campaignId` / `leadId` every time). camelCase wins when both are sent; neither is a clear refusal.
 */
export function idArg(args: Record<string, unknown>, camel: string, snake: string): string {
  for (const k of [camel, snake]) {
    const v = args[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  throw new Error(`Missing \`${camel}\` (the older name \`${snake}\` also works).`);
}

/**
 * Throw the gateway's refusal as-is. A body carrying a `code` (org_target_required,
 * brand_in_several_orgs, org_not_member, ...) is serialized whole, so the client
 * reads `code`, `message`, `fix` and `organizations` rather than a bare word.
 */
function failWith(result: { error?: string; errorBody?: ApiErrorBody; status?: number }): never {
  if (result.status === 402) throw new Error(JSON.stringify(paymentRequired(result)));
  if (result.errorBody && typeof result.errorBody.code === "string") {
    throw new Error(JSON.stringify(result.errorBody));
  }
  throw new Error(result.error ?? "Request failed");
}

/**
 * A paid call on an organization with no prepaid balance comes back `402
 * payment_required`, with the gateway's `message` and `prepay` block (path,
 * minimums, example body). Kept whole, with the tool that does it named on top,
 * so the agent prepays and retries instead of reading a generic failure.
 */
export function paymentRequired(result: { error?: string; errorBody?: ApiErrorBody; status?: number }): Record<string, unknown> {
  return {
    status: 402,
    ...(result.errorBody ?? { error: result.error ?? "payment_required" }),
    nextStep:
      "This call costs money and the organization has no prepaid balance. Call distribute_prepay (amounts in cents: " +
      `topup_amount_cents >= ${PREPAY_MINIMUMS.topup_amount_cents}, auto_topup_amount_cents >= ${PREPAY_MINIMUMS.auto_topup_amount_cents}, ` +
      `auto_topup_threshold_cents >= ${PREPAY_MINIMUMS.auto_topup_threshold_cents}). It returns a payment url: open it, or give it to your human to pay by card. ` +
      "Check with distribute_prepaid_status, then retry this call.",
  };
}

/**
 * The gateway's prepaid minimums (api-service `src/lib/agent-prepay.ts`, owner
 * 2026-10-12: $10 prepay, $15 reload, $5 threshold). Named here only to tell an
 * agent what to send; the gateway is what refuses less (`amount_below_minimum`).
 */
export const PREPAY_MINIMUMS = {
  topup_amount_cents: 1000,
  auto_topup_amount_cents: 1500,
  auto_topup_threshold_cents: 500,
} as const;

/**
 * Said in every signup and prepay tool, and in the discovery document: an agent
 * gets its own key and pays for itself, with no human in the loop.
 */
export const NO_HUMAN_NEEDED =
  "No human needed: request a key with an email, prepay when you need to spend.";

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
      "A key belongs to its USER and reaches every organization that user is a member of; it never belongs to a brand. " +
      "Call this first: the other tools take a brandId (and an orgId when a brand sits in several organizations) from this list. " +
      "Then, before acting on what the client asks (set something up, change how a campaign behaves, launch, attach files, caps...), " +
      "read the method: distribute_list_skills, then distribute_read_skill on `index` and on every skill whose description matches the ask. " +
      "They are the steps our own Copilot follows; an API route alone rarely is the whole setup. " +
      "A key that reaches many organizations (a distribute.you staff key reaches all of them) should pass `search` " +
      "with a name or domain (\"acme\", \"acme.com\") to get only the organizations and brands that match. " +
      "Keys are created and revoked at https://dashboard.distribute.you and sent as `Authorization: Bearer <key>`.",
    schema: z.object({
      search: z
        .string()
        .optional()
        .describe("Only the organizations whose id or name contains this text, or that hold a brand whose id, name or domain contains it (case-insensitive)."),
    }),
  },
  distribute_list_skills: {
    description:
      "List the method skills: how to organize a client's request on distribute.you (offers and their documents, the catalogue, sales funnels, " +
      "campaigns and their caps, triggers, billing, workflows and plays...), the same skills our own Copilot follows. Each skill has a `slug`, a `title`, " +
      "and a `description` saying when to read it; `parentSlug` places it in the tree (root: `index`). " +
      "Read this BEFORE acting on a client ask, then read `index` and every matching skill with distribute_read_skill. " +
      "Free, read-only, the same for every client: names no brand or organization.",
    schema: z.object({}),
  },
  distribute_read_skill: {
    description:
      "Read one method skill in full (markdown `content`): the steps, the API operations to call in order and the traps. " +
      "Start with `index`, then the skills distribute_list_skills shows matching the client's ask. Follow them; " +
      "run the operations they name with distribute_call_api (distribute_describe_api for their parameters). Free, read-only.",
    schema: z.object({
      slug: z.string().describe("Skill slug from distribute_list_skills, e.g. `index`, `offers`, `campaigns`."),
    }),
  },
  distribute_signup_start: {
    description:
      NO_HUMAN_NEEDED + " " +
      "Step 1 of 2 to open a distribute.you account and get an API key, with no key and no dashboard. " +
      "Give an email you can read and a phone number in international format (+33612345678; only its format is checked). " +
      "A 6-digit code is emailed; then call distribute_signup_complete with it. " +
      "An email that already has an account works too: it gets one more key for that account. " +
      "Free to call. Pay as you go: you prepay a balance when you want to spend (distribute_prepay), and each action is billed at its price on https://distribute.you/catalog.",
    schema: z.object({
      email: z.string().describe("Email to open the account with. The code is sent there."),
      phone: z.string().describe("Phone number in international format, e.g. +33612345678. Only its format is checked."),
    }),
  },
  distribute_signup_complete: {
    description:
      "Step 2 of 2: send the 6-digit code emailed by distribute_signup_start and get an API key. " +
      "This MCP session uses the new key at once (when it had none), so every other tool works right after. " +
      "Keep `apiKey`: it is shown once. To use it later, reconnect this MCP server with the header `Authorization: Bearer <apiKey>`, " +
      "or call https://api.distribute.you with that header. Each call makes a NEW key. " +
      "Reading the account is free; anything that spends needs a prepaid balance first (distribute_prepay).",
    schema: z.object({
      email: z.string().describe("The email given to distribute_signup_start."),
      code: z.string().describe("The 6-digit code emailed to it."),
      keyName: z.string().optional().describe("A name for the key, to recognize it later (e.g. the agent's name)."),
    }),
  },
  distribute_prepay: {
    description:
      NO_HUMAN_NEEDED + " " +
      "Prepay before calls that spend money (a call that needs money and finds none answers 402 payment_required). " +
      "Returns a payment `url`: open it, or give it to your human to pay by card. The card is saved and reloads the balance automatically: " +
      "when the balance falls under `auto_topup_threshold_cents`, it adds `auto_topup_amount_cents`. Auto top-up is required. " +
      "Amounts in cents, minimums: topup_amount_cents 1000 ($10), auto_topup_amount_cents 1500 ($15), auto_topup_threshold_cents 500 ($5). " +
      "Less is refused with `amount_below_minimum`, naming the field. " +
      "Pay as you go: each action is billed from the balance at its price on https://distribute.you/catalog " +
      "(an email sent is priced by its BounceVerify verdict). What a campaign may spend is its own cap, set on the campaign. " +
      "Then check distribute_prepaid_status until `state` is `active`. " +
      TARGET_HINT,
    schema: z.object({
      topup_amount_cents: z.number().int().describe("First prepayment, in cents. At least 1000 ($10)."),
      auto_topup_amount_cents: z.number().int().describe("Amount added at each automatic reload, in cents. At least 1500 ($15)."),
      auto_topup_threshold_cents: z.number().int().describe("Balance under which the card reloads, in cents. At least 500 ($5)."),
      success_url: z.string().optional().describe("Page shown after paying (default https://distribute.you/?prepaid=paid)."),
      cancel_url: z.string().optional().describe("Page shown if payment is cancelled (default https://distribute.you/?prepaid=cancelled)."),
      ...targetShape,
    }),
  },
  distribute_prepaid_status: {
    description:
      "Read the prepaid account: `state` (awaiting_payment: not paid yet; active: ready to spend; card_not_reloadable or auto_topup_off: fix it with distribute_prepay; not_prepaid), " +
      "`balance_cents`, `paid_cents`, the automatic reload settings and whether the saved card can reload. Free to call. " +
      TARGET_HINT,
    schema: z.object({ ...targetShape }),
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
      "List the campaigns of one brand or organization. A campaign is one sales funnel run for one offer of a brand, started or paused as a whole. Each campaign has a name, a status (`ongoing` = running, `stopped` = paused), " +
      "a type (`proactive`: it reaches out to new people on its own; `reactive`: it acts when something happens, such as a reply), " +
      "and its caps: a max budget and/or a max volume per period, in words in `budget` and `volume` (\"Max $10/day\", \"Up to 50 leads handled/week\"), with what the current period used in `maxBudget` and `maxVolume`. " +
      "A campaign with no max budget spends nothing. Report each campaign by its name. " +
      "Each campaign also says what starts it, in `runsWhen` (\"Each time: Email Pushed Via API\" for a reactive campaign, with its `trigger` {slug, name}; " +
      "\"On its own, within its caps (no trigger)\" for a proactive one), and what it does, in `path` (its steps in order, e.g. \"Lead found → Sales Cold Email Outreach → Positive reply → Paid client\"). " +
      "Before telling the client something is missing, read the running (`ongoing`) campaigns: one may already do what they ask " +
      "(e.g. send an email they wrote: a running campaign that runs \"Each time: Email Pushed Via API\"). " +
      TARGET_HINT,
    schema: z.object({
      ...targetShape,
      status: z.enum(["ongoing", "stopped", "all"]).optional().describe("Filter by campaign status: `ongoing` (running) or `stopped`. `all`, or no status, returns every campaign. Any other value is refused."),
    }),
  },
  distribute_campaign_stats: {
    description:
      "Get one campaign's results: pass `campaignId`, the campaign id from distribute_list_campaigns (the older name `campaign_id` still works). A campaign runs as one; its results come in `results`, " +
      "one entry per thing it brings in (`bringsIn`, such as a positive reply or a lead found) with the channel doing it (`channel`). " +
      "An id seen elsewhere (trigger events, offer stats, a lead's `campaignId`) is one step of a campaign: pass it too, the answer names its campaign in `note`. " +
      "Report the campaign by its name and never call an entry of `results` a campaign. " +
      "Report meetings, positive replies and delivery rate first, then volume and cost; " +
      "bounces and other failures last. Each entry is ordered that way: `headline`, then `summary`, then the raw figures, then `failureDetails`. " +
      "Show zeros plainly (0 meetings is still reported). " +
      TARGET_HINT,
    schema: z.object({
      campaignId: z.string().optional().describe("Campaign id, from distribute_list_campaigns. Required (or `campaign_id`)."),
      campaign_id: z.string().optional().describe("Older name of `campaignId`, still accepted. Prefer `campaignId`."),
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
      "Each lead carries an `id` (this lead on one campaign) to pass to distribute_get_lead for its emails and conversation, " +
      "and a `leadId` (the person, the id trigger events and emails name; distribute_get_lead takes it too). " +
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
      "(`subject`, then `sequence`: one entry per step with its `bodyText`, its `kind` (first_email or follow_up) and its send `status`: " +
      "`sent` at `sentAt`, `queued` (goes out in the prospect's business hours) or `stopped` (will not go out: reply, bounce, opt-out, meeting, sequence stopped)), " +
      "with who it went to (`leadEmail`, lead name, title, company, `leadId`). Use it to answer \"what did you send for my brand, and what is still queued\". " +
      "Replies and delivery are on distribute_list_leads / distribute_get_lead. " +
      "Pages with `limit` and `offset`. " +
      TARGET_HINT,
    schema: z.object({
      ...targetShape,
      brandId: z.string().describe("Brand whose emails to list (from distribute_status)."),
      campaignId: z.string().optional().describe("Only the emails of this campaign part."),
      limit: z.number().int().min(1).max(200).optional().describe("Emails per page (default 20, max 200)."),
      offset: z.number().int().min(0).optional().describe("How many to skip (pagination)."),
    }),
  },
  distribute_get_lead: {
    description:
      "Everything about ONE lead in one call: who they are and where they stand (sent, delivered, replied...), the emails we wrote for them " +
      "(first email and follow-ups, subject and body, each with its send status: sent at sentAt, queued or stopped), and the conversation (every message we sent and every reply they wrote, oldest first). " +
      "Pass `leadId`: either a lead's `id` from distribute_list_leads (this lead on one campaign), or the person's id: " +
      "a list row's `leadId`, or the `ranLeads[].leadId` a trigger event (POST /v1/trigger-events) answers. " +
      "With the person's id, also pass `campaignId` (the `ranLeads[].campaignId` beside it, or a lead's `campaignId`) or brandId, " +
      "so the lead is found on that campaign; the answer's `lead.id` is then the lead's `id`. The older name `lead_id` still works. " +
      TARGET_HINT,
    schema: z.object({
      leadId: z.string().optional().describe("A lead's `id` from distribute_list_leads, or the person's id (a list row's `leadId`, a trigger event's `ranLeads[].leadId`). Required (or `lead_id`)."),
      lead_id: z.string().optional().describe("Older name of `leadId`, still accepted. Prefer `leadId`."),
      campaignId: z.string().optional().describe("With a person's id: the campaign step they are on (`ranLeads[].campaignId` of the trigger event, or a lead's `campaignId`)."),
      ...targetShape,
    }),
  },
  distribute_find_api: {
    description:
      "Find how to do something in distribute.you when no other tool covers it. Searches every operation of the distribute.you API " +
      "(the same API and the same scope your key has: leads, emails, conversations, campaigns and their caps, offers, sales funnels, triggers, billing, CRM, stats...) " +
      "by what you want to do, in plain words (\"list the emails sent for my brand\", \"set a campaign's max budget\", \"pause a campaign\", \"account balance\"). " +
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
      "the JSON body it takes, and `answers`: what a successful call returns (per status, the JSON shape with each field's meaning), so you can act on the answer. Name it by `operationId`, or by `method` and `path`, as distribute_find_api returned them.",
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
      return handleStatus(args);

    case "distribute_list_skills":
      return handleListSkills();

    case "distribute_read_skill":
      return handleReadSkill(args);

    case "distribute_signup_start":
      return handleSignupStart(args);

    case "distribute_signup_complete":
      return handleSignupComplete(args);

    case "distribute_prepay":
      return handlePrepay(args);

    case "distribute_prepaid_status":
      return handlePrepaidStatus(args);

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
/** Above this many organizations, distribute_status lists them without their brands, so the answer fits an assistant's context. */
export const STATUS_FULL_LIST_MAX_ORGS = 20;

async function handleStatus(args: Record<string, unknown> = {}) {
  const status = getConfigStatus();
  
  if (!status.configured) {
    return {
      status: "not_configured",
      message: "No distribute.you API key on this session. " + NO_HUMAN_NEEDED,
      instructions: [
        "1. Call distribute_signup_start with an email you can read and a phone number (+33612345678). A 6-digit code is emailed.",
        "2. Call distribute_signup_complete with that email and code. It returns an API key, and this session uses it right away.",
        "3. Reading the account is free. To spend, prepay with distribute_prepay (from $10, auto top-up required) and pay at the url it returns.",
        "Already have a key? Send it as the header Authorization: Bearer <your key> (in an MCP client, put that header in this server's configuration and reconnect). " +
          "A person can also create one at https://dashboard.distribute.you (organization, then API Key).",
      ],
    };
  }

  // Check API connectivity
  const search = typeof args.search === "string" ? args.search.trim() : "";
  const result = await callApi<Record<string, unknown>>(search ? `/v1/me?q=${encodeURIComponent(search)}` : "/v1/me");

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

  // A key in very many organizations (staff) would get an answer no assistant
  // can hold: list them by name only and say how to narrow down.
  const tooMany = !search && organizations !== null && organizations.length > STATUS_FULL_LIST_MAX_ORGS;
  return {
    status: "connected",
    summary: me.summary ?? null,
    user: me.user ?? null,
    ...(search ? { search } : {}),
    organizations: tooMany
      ? organizations.map((o) => ({ id: o.id, name: o.name, brandCount: o.brands.length }))
      : organizations,
    ...(tooMany
      ? {
          narrowDown: `This key reaches ${organizations.length} organizations, listed without their brands. Call distribute_status again with search (a name or domain) to get one organization with its brands.`,
        }
      : {}),
    organization: me.organization ?? null,
    keyScope: me.keyScope ?? null,
    howToTarget: TARGET_HINT,
    lookupErrors: Array.isArray(me.lookupErrors) && me.lookupErrors.length > 0 ? me.lookupErrors : undefined,
    apiUrl: status.apiUrl,
  };
}

/**
 * The agent skill tree (api-service `GET /v1/skills`, chat-service's Copilot skills): the same
 * method our Copilot follows, readable by any key. It is one tree for every client, so neither
 * read names a brand or organization. Who edited a skill is staff bookkeeping: not handed on.
 */
type SkillSummary = { slug: string; parentSlug: string | null; title: string; description: string; position: number };

async function handleListSkills() {
  const result = await callApi<{ skills: SkillSummary[] }>("/v1/skills");
  if (result.error) failWith(result);
  const skills = (result.data as { skills: SkillSummary[] }).skills;
  return {
    next: "Read `index` with distribute_read_skill, then every skill whose description matches the client's ask, before acting.",
    skills: skills.map((s) => ({ slug: s.slug, parentSlug: s.parentSlug, title: s.title, description: s.description })),
  };
}

async function handleReadSkill(args: Record<string, unknown>) {
  const slug = String(args.slug);
  const result = await callApi<SkillSummary & { content: string }>(`/v1/skills/${encodeURIComponent(slug)}`);
  if (result.error) {
    if (result.status === 404) throw new Error(`No skill "${slug}". Take a slug from distribute_list_skills.`);
    failWith(result);
  }
  const s = result.data as SkillSummary & { content: string; version?: number };
  return { slug: s.slug, parentSlug: s.parentSlug, title: s.title, description: s.description, version: s.version, content: s.content };
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

/** The dashboard's words for a campaign's caps: "Max $10/day" (proactive), "Up to $20/week" (reactive). */
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
  const copies = await campaignCopies(listed, args);

  // A projection: name, status, what starts it and what it does, limits. Parts are not listed (they are not campaigns).
  const campaigns = await Promise.all(
    listed.map(async (c) => ({
      id: c.id,
      name: c.salesFunnelName,
      status: c.status,
      stopReason: c.stopReason ?? null,
      brandId: c.brandId,
      offerId: c.offerId,
      ...runsWhenOf(copies.get(c.brandId), c.id),
      ...(await funnelCampaignCaps(c, args)),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  );
  return { campaigns };
}

/** features-service's copy of one campaign (`GET /v1/features/brands/:b/sales-funnel-campaigns?fields=copy`). */
type CampaignCopy = {
  id: string;
  type?: string | null;
  triggerLabel?: string | null;
  path?: { items?: Array<{ kind?: string; slug?: string; key?: string; name?: string; label?: string }> } | null;
};
type CopiesRead = { rows: Map<string, CampaignCopy> } | { error: string };

/**
 * What starts each campaign and what it does, as the dashboard's Campaigns table shows it: one cheap
 * read per brand (`fields=copy`: no money computed). A refused read does not hide the campaigns: each
 * one of that brand says why `runsWhen` is unknown.
 */
async function campaignCopies(listed: FunnelCampaign[], args: Record<string, unknown>): Promise<Map<string, CopiesRead>> {
  const brands = [...new Set(listed.map((c) => c.brandId))];
  return new Map(
    await Promise.all(
      brands.map(async (b): Promise<[string, CopiesRead]> => {
        const read = await callApi<{ salesFunnelCampaigns?: CampaignCopy[] }>(
          withTarget(`/v1/features/brands/${encodeURIComponent(b)}/sales-funnel-campaigns?fields=copy`, { brandId: b, orgId: args.orgId }),
        );
        const rows = read.error ? null : (read.data as { salesFunnelCampaigns?: CampaignCopy[] }).salesFunnelCampaigns;
        if (!Array.isArray(rows)) {
          const why = read.error ?? "no salesFunnelCampaigns in the answer";
          console.error("[mcp] campaign copy unreadable", { brandId: b, why });
          return [b, { error: why }];
        }
        return [b, { rows: new Map(rows.map((r) => [r.id, r])) }];
      }),
    ),
  );
}

/** "Each time: Email Pushed Via API" (reactive) or "On its own, within its caps (no trigger)" (proactive). */
export function runsWhenOf(read: CopiesRead | undefined, campaignId: string) {
  const unknown = (reason: string) => ({ runsWhen: null, trigger: null, path: null, runsWhenUnavailableReason: reason });
  if (!read) return unknown("not read");
  if ("error" in read) return unknown(`could not be read: ${read.error}`);
  const copy = read.rows.get(campaignId);
  if (!copy) return unknown("this campaign is missing from the brand's campaign descriptions");
  const items = copy.path?.items ?? [];
  const t = items.find((i) => i.kind === "trigger");
  const trigger = t && t.slug && t.name ? { slug: t.slug, name: t.name } : null;
  const label = copy.triggerLabel ?? trigger?.name ?? null;
  const runsWhen = label ? `Each time: ${label}` : copy.type === "proactive" ? "On its own, within its caps (no trigger)" : null;
  const path = items.length ? items.map((i) => (i.kind === "step" ? i.label : i.name) ?? "?").join(" → ") : null;
  return {
    runsWhen,
    trigger,
    path,
    ...(runsWhen ? {} : { runsWhenUnavailableReason: "no trigger and no type described for this campaign" }),
  };
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

/**
 * The campaign an id names. A campaign id resolves directly. An id that is one PART of a
 * campaign (the id trigger events, offer stats and lead rows carry) resolves to the campaign
 * holding it, read off the campaign list's own parts: the agent gets that campaign's results
 * and is told which campaign it is, never a dead end and never the part as a campaign.
 */
async function campaignNamedBy(args: Record<string, unknown>): Promise<{ campaign: FunnelCampaign; viaPart: boolean }> {
  const given = idArg(args, "campaignId", "campaign_id");
  const one = await callApi<{ salesFunnelCampaign: FunnelCampaign }>(
    withTarget(`/v1/sales-funnel-campaigns/${encodeURIComponent(given)}`, args),
  );
  if (!one.error) return { campaign: (one.data as { salesFunnelCampaign: FunnelCampaign }).salesFunnelCampaign, viaPart: false };
  if (one.status !== 404) failWith(one);

  const all = await callApi<{ salesFunnelCampaigns: FunnelCampaign[] }>(withTarget("/v1/sales-funnel-campaigns", args));
  if (all.error) failWith(all);
  const holder = (all.data as { salesFunnelCampaigns: FunnelCampaign[] }).salesFunnelCampaigns.find((c) =>
    c.units.some((u) => u.campaignId === given),
  );
  if (holder) return { campaign: holder, viaPart: true };
  throw new Error(
    `No campaign ${given} in this organization, and no campaign of it has a step with this id. ` +
      "Take the campaign id from distribute_list_campaigns. " +
      TARGET_HINT,
  );
}

async function handleCampaignStats(args: Record<string, unknown>) {
  const { campaign, viaPart } = await campaignNamedBy(args);

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
    ...(viaPart
      ? {
          note:
            `The id you gave is not a campaign: it is one step of the campaign "${campaign.salesFunnelName}" (campaign id ${campaign.id}). ` +
            "These are that whole campaign's results. Use the campaign id from now on.",
        }
      : {}),
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

/**
 * What happened to each email step, as the API serves it on GET /v1/email-sequences
 * (instantly-service owns it): `sent` at `sentAt`, `queued` (goes out in the
 * prospect's business hours), or `stopped` (will not go out). One row per sequence;
 * a prospect emailed again after the re-contact window has two.
 */
type SendStep = { step: number; kind: string; status: string; sentAt: string | null };
type SendSequence = { leadId: string | null; leadEmail: string | null; campaignId: string | null; steps: SendStep[] };
type SendRecords = { byLead: Map<string, SendSequence[]>; complete: boolean; error?: unknown };

/** Pages of 2000 (the route's max); a brand of 50k prospects stops here rather than paging forever. */
const SEND_RECORD_MAX_PAGES = 25;

/**
 * The brand's send records, paged until every wanted lead is found or the
 * brand is exhausted. A refusal is returned, never thrown: the written emails
 * are still worth reading without their status, and the refusal says why.
 */
async function sendRecordsFor(brandId: string, orgId: unknown, wanted: Set<string>): Promise<SendRecords> {
  const byLead = new Map<string, SendSequence[]>();
  let cursor: string | null = null;
  for (let page = 0; page < SEND_RECORD_MAX_PAGES; page++) {
    const params = new URLSearchParams({ brandId, limit: "2000" });
    if (cursor) params.set("cursor", cursor);
    const res = await callApi<{ sequences: SendSequence[]; nextCursor: string | null }>(withTarget(`/v1/email-sequences?${params}`, { orgId }));
    if (res.error) {
      console.error("[mcp] email send status unavailable", { brandId, status: res.status ?? null, error: res.errorBody ?? res.error });
      return { byLead, complete: false, error: { status: res.status ?? null, ...(res.errorBody ?? { error: res.error }) } };
    }
    const data = res.data as { sequences: SendSequence[]; nextCursor: string | null };
    for (const seq of data.sequences) {
      if (!seq.leadId) continue;
      const list = byLead.get(seq.leadId) ?? [];
      list.push(seq);
      byLead.set(seq.leadId, list);
    }
    cursor = data.nextCursor;
    if (!cursor) return { byLead, complete: true };
    if ([...wanted].every((id) => byLead.has(id))) return { byLead, complete: true };
  }
  console.error("[mcp] email send status: page cap reached", { brandId, pages: SEND_RECORD_MAX_PAGES });
  return { byLead, complete: false };
}

/**
 * A written email with what happened to each of its steps, joined on leadId and
 * step (the sequence of the same campaign when a prospect has several). Every
 * written step carries `kind`, `status` and `sentAt`; a step the sequence holds
 * but the written email does not is listed after them, with no body.
 */
function withSendStatus(email: Record<string, unknown>, records: SendRecords): Record<string, unknown> {
  const leadId = typeof email.leadId === "string" ? email.leadId : null;
  const candidates = (leadId && records.byLead.get(leadId)) || [];
  const seq =
    candidates.find((c) => c.campaignId && c.campaignId === email.campaignId) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!seq) {
    const why = records.error
      ? "The send status could not be read: see sendStatusUnavailable."
      : candidates.length > 1
        ? "This prospect has several sequences and none matches this email's campaign."
        : records.complete
          ? "No send record: none of these emails has been queued or sent yet."
          : "Not found within the pages read.";
    return { ...email, sendStatusNote: why };
  }
  const written = Array.isArray(email.sequence) ? (email.sequence as Array<Record<string, unknown>>) : [];
  const byStep = new Map(seq.steps.map((st) => [st.step, st]));
  const steps: Array<Record<string, unknown>> = written.map((w) => {
    const st = byStep.get(Number(w.step));
    return { ...w, kind: st?.kind ?? null, status: st?.status ?? null, sentAt: st?.sentAt ?? null };
  });
  const writtenSteps = new Set(written.map((w) => Number(w.step)));
  for (const st of seq.steps) {
    if (!writtenSteps.has(st.step)) steps.push({ step: st.step, bodyText: null, kind: st.kind, status: st.status, sentAt: st.sentAt });
  }
  return { ...email, leadEmail: seq.leadEmail, sequence: steps };
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
  const wanted = new Set(emails.map((e) => e.leadId).filter((id): id is string => typeof id === "string"));
  const records: SendRecords = wanted.size
    ? await sendRecordsFor(String(args.brandId), args.orgId, wanted)
    : { byLead: new Map(), complete: true };
  return {
    count: emails.length,
    // A full page means there may be more: ask again from the next offset.
    nextOffset: emails.length === limit ? offset + limit : null,
    ...(records.error ? { sendStatusUnavailable: records.error } : {}),
    emails: emails.map((e) => emailForAssistant(withSendStatus(e, records))),
  };
}

/** How many pages of 200 a person's id is looked for in, before saying where to look instead. */
export const PERSON_LOOKUP_MAX_PAGES = 5;

/**
 * Two ids name a lead (lead-service): a list row's `id` is the person ON ONE CAMPAIGN (what
 * `GET /v1/leads/{id}` reads), its `leadId` is the PERSON (what a trigger event's `ranLeads[].leadId`,
 * an email and a timeline name). The gateway reads a lead by the first only, so a person's id is
 * looked up in the campaign's (or brand's) newest leads, then read by its row `id`.
 */
async function leadRowIdOfPerson(personId: string, args: Record<string, unknown>): Promise<{ id: string; others: string[] } | null> {
  const campaignId = typeof args.campaignId === "string" && args.campaignId ? args.campaignId : null;
  const brandId = typeof args.brandId === "string" && args.brandId ? args.brandId : null;
  if (!campaignId && !brandId) return null;
  const found: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PERSON_LOOKUP_MAX_PAGES; page++) {
    const params = new URLSearchParams({ ...(campaignId ? { campaignId } : {}), ...(brandId ? { brandId } : {}), view: "compact", status: "all", limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const list = await callApi<{ leads: Array<Record<string, unknown>>; nextCursor?: string | null }>(
      withTarget(`/v1/leads?${params}`, { orgId: args.orgId }),
    );
    if (list.error) failWith(list);
    const data = list.data as { leads: Array<Record<string, unknown>>; nextCursor?: string | null };
    for (const r of data.leads ?? []) if (r.leadId === personId && typeof r.id === "string") found.push(r.id);
    cursor = data.nextCursor ?? null;
    if (found.length > 0 || !cursor) break;
  }
  return found.length ? { id: found[0]!, others: found.slice(1) } : null;
}

async function handleGetLead(args: Record<string, unknown>) {
  const given = idArg(args, "leadId", "lead_id");
  const read = (id: string) => callApi<{ leadDetail: Record<string, unknown> }>(withTarget(`/v1/leads/${encodeURIComponent(id)}`, args));
  let one = await read(given);
  let viaPerson: { id: string; others: string[] } | null = null;
  // 404: not a lead row id; 400: not even shaped like one. Either way it may be the person's id.
  if (one.error && (one.status === 404 || one.status === 400)) {
    viaPerson = await leadRowIdOfPerson(given, args);
    if (viaPerson) one = await read(viaPerson.id);
  }
  if (one.error) {
    if (one.status === 404 || one.status === 400) {
      throw new Error(
        `No lead ${given} here. distribute_get_lead takes a lead's \`id\` from distribute_list_leads, ` +
          "or a person's id (a list row's `leadId`, a trigger event's `ranLeads[].leadId`) together with `campaignId` " +
          "(the `ranLeads[].campaignId` beside it) or brandId. " +
          (args.campaignId || args.brandId
            ? `This person is not among the newest ${PERSON_LOOKUP_MAX_PAGES * 200} leads of that ${args.campaignId ? "campaign" : "brand"}. `
            : "") +
          TARGET_HINT,
      );
    }
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
  const records = generation && brandId && leadId ? await sendRecordsFor(brandId, args.orgId, new Set([leadId])) : null;
  return {
    ...(viaPerson
      ? {
          note:
            `${given} is the person's id; this is them on campaign ${String(row.campaignId ?? "?")}, lead id ${viaPerson.id}.` +
            (viaPerson.others.length ? ` They are on other campaigns too, as leads ${viaPerson.others.join(", ")}.` : ""),
        }
      : {}),
    lead: leadForAssistant(row),
    emailsWritten: generation ? emailForAssistant(records ? withSendStatus(generation, records) : generation) : null,
    ...(records?.error ? { sendStatusUnavailable: records.error } : {}),
    ...(written.error ? { emailsWrittenUnavailable: written.errorBody ?? { error: written.error, status: written.status ?? null } } : {}),
    conversation: conversation.error ? null : forCustomer((conversation.data as { conversation?: unknown }).conversation ?? conversation.data),
    ...(conversation.error
      ? { conversationUnavailable: conversation.errorBody ?? { error: conversation.error, status: conversation.status ?? null } }
      : {}),
  };
}

// ── Agent signup and prepay ──────────────────────────────────────────────────

/**
 * An agent opens its own account (owner 2026-10-12): the gateway's public
 * `/v1/agent-signups/{start,complete}` take no key, mint one, and the agent
 * prepays through `/v1/billing/accounts/prepaid_checkout`. Bodies and refusals
 * are the gateway's, handed back whole (code_invalid, code_expired,
 * amount_below_minimum ... each with its `message`).
 */
function failWhole(result: { error?: string; errorBody?: ApiErrorBody; status?: number }): never {
  if (result.status === 402) throw new Error(JSON.stringify(paymentRequired(result)));
  throw new Error(JSON.stringify({ status: result.status ?? null, ...(result.errorBody ?? { error: result.error }) }));
}

async function handleSignupStart(args: Record<string, unknown>) {
  const result = await callApi<Record<string, unknown>>("/v1/agent-signups/start", {
    method: "POST",
    body: { email: args.email, phone: args.phone },
    public: true,
  });
  if (result.error) failWhole(result);
  return {
    ...(result.data as Record<string, unknown>),
    next: "A 6-digit code was emailed. Call distribute_signup_complete with this email and the code.",
  };
}

async function handleSignupComplete(args: Record<string, unknown>) {
  const body: Record<string, unknown> = { email: args.email, code: args.code };
  if (typeof args.keyName === "string") body.keyName = args.keyName;
  const result = await callApi<Record<string, unknown>>("/v1/agent-signups/complete", {
    method: "POST",
    body,
    public: true,
  });
  if (result.error) failWhole(result);
  const data = result.data as Record<string, unknown>;
  return {
    ...data,
    keepThisKey: "apiKey is shown once. Store it: it is the account's password.",
    useTheKey: {
      thisSession: "This MCP session now uses this key when it had none: call distribute_status next.",
      reconnectMcp: "Later, connect to https://mcp.distribute.you/mcp with the header `Authorization: Bearer <apiKey>`.",
      api: "Or call https://api.distribute.you with the same header (first call: GET /v1/me).",
    },
    toSpend: "Reading is free. Before any call that spends, prepay with distribute_prepay (from $10, auto top-up required).",
  };
}

/**
 * The key a successful distribute_signup_complete minted, for the session to
 * adopt. Only for that tool, and only a string key: nothing else a tool returns
 * can change which key a session calls with.
 */
export function mintedKey(tool: string, result: unknown): string | null {
  if (tool !== "distribute_signup_complete" || !result || typeof result !== "object") return null;
  const key = (result as Record<string, unknown>).apiKey;
  return typeof key === "string" && key ? key : null;
}

async function handlePrepay(args: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    topup_amount_cents: args.topup_amount_cents,
    auto_topup_amount_cents: args.auto_topup_amount_cents,
    auto_topup_threshold_cents: args.auto_topup_threshold_cents,
  };
  if (typeof args.success_url === "string") body.success_url = args.success_url;
  if (typeof args.cancel_url === "string") body.cancel_url = args.cancel_url;
  const result = await callApi<Record<string, unknown>>(withTarget("/v1/billing/accounts/prepaid_checkout", args), {
    method: "POST",
    body,
  });
  if (result.error) failWhole(result);
  return {
    ...(result.data as Record<string, unknown>),
    next: "Open `url` to pay by card, or give it to your human. Then call distribute_prepaid_status until `state` is `active`, and retry what needed money.",
  };
}

async function handlePrepaidStatus(args: Record<string, unknown>) {
  const result = await callApi<Record<string, unknown>>(withTarget("/v1/billing/accounts/prepaid_status", args));
  if (result.error) failWhole(result);
  return result.data;
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
    ...(op.staffOnly ? { staffOnly: "Served to this session because its key is a distribute.you staff key. The gateway checks it again on the call." } : {}),
    parameters: op.params,
    body: op.hasBody ? resolveSchema(op.bodySchema, components) : null,
    answers: describeAnswers(op, components),
    howToCall: {
      tool: "distribute_call_api",
      method: op.method,
      path: `${op.path}  (fill each {param} with its value)`,
      targeting: TARGET_HINT,
    },
  };
}

/** Above this, one success answer's schema is inlined less deep: a huge schema must not flood the context. */
export const MAX_ANSWER_SCHEMA_CHARS = 12_000;

/**
 * What a successful call answers, from the gateway's served document only: per
 * 2xx status, its description and its JSON shape with refs inlined. A shape too
 * large at full depth is inlined less deep (deeper parts named, not expanded);
 * one still too large lists its top-level fields. An operation whose document
 * states no success answer says so, never a guess.
 */
function describeAnswers(op: CatalogOperation, components: Record<string, unknown>): unknown {
  if (op.successResponses.length === 0) {
    return "Not documented by the gateway for this operation: read the answer as it comes back from distribute_call_api.";
  }
  return op.successResponses.map((r) => {
    const base = { status: Number(r.status), description: r.description };
    if (r.contentType) return { ...base, contentType: r.contentType, body: `Not JSON: ${r.contentType}.` };
    if (r.schema === null) return { ...base, body: "Shape not documented by the gateway." };
    for (let depth = 4; depth >= 0; depth -= 1) {
      const body = resolveSchema(r.schema, components, depth);
      if (JSON.stringify(body).length <= MAX_ANSWER_SCHEMA_CHARS) {
        return depth === 4 ? { ...base, body } : { ...base, body, note: `Large shape: nested schemas past ${depth} level(s) are named ({ $ref }), not expanded.` };
      }
    }
    const top = resolveSchema(r.schema, components, 1) as { properties?: Record<string, unknown> };
    return { ...base, body: { fields: Object.keys(top?.properties ?? {}) }, note: "Shape too large to inline: top-level field names only." };
  });
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

  // Only operations of the catalogue the gateway serves THIS key: a staff route
  // is in it for a staff user's key alone, so a client key cannot reach it here.
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
    // The staff Unibox shows which operation a generic call ran, not only "call_api".
    mcpTool: `distribute_call_api ${match.operation.method} ${match.operation.path}`,
  });
  if (result.error) failWhole(result);

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
