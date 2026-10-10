import { z } from "zod";
import { getConfigStatus, callApi, type ApiErrorBody } from "../lib/api-client.js";

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
  if (Array.isArray(value)) return value.map(withoutOpens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "opened" && k !== "openRate" && k !== "opens")
        .map(([k, v]) => [k, withoutOpens(v)]),
    );
  }
  return value;
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
