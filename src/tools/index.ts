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
    description:
      "Check the connection and say who the key belongs to: the organization's name, its brands, and the user. " +
      "A key belongs to ONE user in ONE organization (the one active when the key was created), never to a brand, and carries no staff or beta powers. " +
      "Keys are created and revoked at https://dashboard.distribute.you and sent as `Authorization: Bearer <key>`.",
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
      status: z.enum(["ongoing", "stopped", "all"]).optional().describe("Filter by campaign status. `ongoing` is the vocabulary the platform stores — an unrecognised value is not refused, it is ignored, and the whole list comes back."),
    }),
  },
  distribute_campaign_stats: {
    description:
      "Get one campaign's results. Report meetings, positive replies and delivery rate first, then volume and cost; " +
      "bounces and other failures last. The response is ordered that way: `headline`, then `summary`, then the raw figures, then `failureDetails`. " +
      "Show zeros plainly (0 meetings is still reported).",
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

  const me = result.data as Record<string, unknown>;
  const brands = await callApi<{ brands: Array<Record<string, unknown>> }>("/v1/brands");
  if (brands.error) throw new Error(brands.error);

  return {
    status: "connected",
    organization: {
      id: me.orgId ?? null,
      name: organizationNameOf(me),
    },
    brands: (brands.data as { brands: Array<Record<string, unknown>> }).brands.map((b) => ({
      id: b.id ?? null,
      name: b.name ?? null,
      domain: b.domain ?? null,
    })),
    keyScope: KEY_SCOPE,
    apiUrl: status.apiUrl,
    user: me,
  };
}

/**
 * What a key IS, stated where an assistant reads it. Without it, one told a
 * user their key "belongs to a user account, not a brand" and could not explain
 * why it read a client organization: the key belongs to whichever organization
 * was active when it was created.
 */
const KEY_SCOPE =
  "This key belongs to one user in one organization: the organization that was active when the key was created. " +
  "It reads that organization and all of its brands, nothing else. It never belongs to a single brand, " +
  "and it never carries staff or beta powers. To read another organization, create a key while that organization is active.";

/**
 * `/v1/me` serves `userId`, `orgId` and `authType` today; api-service is adding
 * the organization's name. Read it under the spellings it may land as, and say
 * plainly when it is not served yet rather than invent one.
 */
function organizationNameOf(me: Record<string, unknown>): string | null {
  const org = me.organization as Record<string, unknown> | undefined;
  const name = me.orgName ?? me.organizationName ?? org?.name;
  return typeof name === "string" && name ? name : null;
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
  const result = await callApi<{ campaigns: Array<Record<string, unknown>> }>(
    `/v1/campaigns?status=${status}`,
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const campaigns = (result.data as { campaigns: Array<Record<string, unknown>> }).campaigns;

  // A projection, not the row. The gateway returns 34 fields per campaign including
  // the brand's whole offer, ~380 characters of it each, and one real account's 134
  // campaigns came to 322KB — which an MCP client refuses outright, so the tool
  // returned nothing usable at all. These fields are 26KB for the same rows.
  // Anything deeper belongs to a per-campaign tool, where one row can afford it.
  return {
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      stopReason: c.stopReason ?? null,
      funnelKey: c.funnelKey ?? null,
      brandIds: c.brandIds ?? null,
      workflowSlug: c.workflowSlug ?? null,
      maxBudgetDailyUsd: c.maxBudgetDailyUsd ?? null,
      createdAt: c.createdAt ?? null,
      updatedAt: c.updatedAt ?? null,
    })),
  };
}

async function handleCampaignStats(args: Record<string, unknown>) {
  const result = await callApi<Record<string, unknown>>(
    `/v1/campaigns/${args.campaign_id}/stats`,
  );

  if (result.error) {
    throw new Error(result.error);
  }

  // The gateway serves its own success-first `headline` block; its figures are
  // folded into `summary` so the one-line sentence keeps the `headline` key.
  const { headline: served, ...raw } = withoutOpens(result.data) as Record<string, unknown>;
  const summary = successFirstSummary(raw, (served ?? {}) as Record<string, unknown>);

  // Key order IS the reading order: an assistant summarizing this JSON reports
  // what it reads first. Every other field the gateway served stays, untouched,
  // in between; only its position relative to the summary changed.
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
    costUsd: num(raw.totalCostUsd),
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

async function handleListBrands() {
  const result = await callApi("/v1/brands");

  if (result.error) {
    throw new Error(result.error);
  }

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
  const brandUrl = String(args.brand_url ?? "");
  const wanted = hostnameOf(brandUrl);
  if (!wanted) throw new Error(`Not a URL: ${brandUrl}`);

  const brands = await callApi<{ brands: Array<{ id: string; domain?: string | null }> }>("/v1/brands");
  if (brands.error) throw new Error(brands.error);

  const match = (brands.data as { brands: Array<{ id: string; domain?: string | null }> }).brands
    .find((b) => b.domain && hostnameOf(`https://${b.domain}`) === wanted);

  if (!match) {
    throw new Error(
      `No brand on this organization matches ${wanted}. Use distribute_list_brands to see what is available.`,
    );
  }

  const result = await callApi(`/v1/brands/${match.id}/icp/suggest`, { method: "POST", body: {} });

  if (result.error) {
    throw new Error(result.error);
  }

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
