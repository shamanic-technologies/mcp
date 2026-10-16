# distribute.you MCP

A remote [MCP](https://modelcontextprotocol.io) server for [distribute.you](https://distribute.you). Point any MCP client at it with your distribute.you API key and do from there everything the [distribute.you API](https://api.distribute.you/openapi.json) lets that key do: read brands, campaigns and their results, leads, the emails we wrote and sent with every follow-up, each prospect's conversation, and reach every other API operation (campaign caps, offers, audiences, billing, CRM...) by describing what you want.

It is a **remote HTTP server**, not an npx package. Nothing is published to npm and nothing is installed locally — a client connects over Streamable HTTP and authenticates with a header.

## No human needed: an agent gets its own key

An AI agent can open a distribute.you account, get an API key and prepay, all through this server, with no key to start and no human in the loop. Request a key with an email, prepay when you need to spend.

1. Connect to `https://mcp.distribute.you/mcp` with no header.
2. `distribute_signup_start` with an email the agent can read and a phone number in international format (`+33612345678`, only its format is checked). A 6-digit code is emailed.
3. `distribute_signup_complete` with the email and the code. It returns `apiKey` (shown once: store it). The session uses it right away. Later, reconnect with `Authorization: Bearer <apiKey>`, or call `https://api.distribute.you` with that header. Each call makes a new key; an email that already has an account gets one more key for it.
4. Reading the account is free. Before anything that spends, `distribute_prepay` with amounts in cents (minimums: `topup_amount_cents` 1000 = $10, `auto_topup_amount_cents` 1500 = $15, `auto_topup_threshold_cents` 500 = $5). It returns a payment `url`: open it, or hand it to a human to pay by card. Auto top-up is required. Less than a minimum is refused with `amount_below_minimum`, naming the field.
5. `distribute_prepaid_status` until `state` is `active`.

Pay as you go: you prepay a balance, and each action is billed from it at its price on [distribute.you/catalog](https://distribute.you/catalog) (an email sent is priced by its BounceVerify verdict). What a campaign may spend is its own cap. A call that costs money on an account with no balance comes back `402 payment_required` with the gateway's `prepay` block and a `nextStep` naming `distribute_prepay`, so the agent prepays and retries.

## Connecting

Create a key at [dashboard.distribute.you](https://dashboard.distribute.you), under **API Key**. The key carries your identity, so anyone holding it can read every organization you belong to — treat it like a password, and delete it from the same page to revoke it.

Claude Code:

```bash
claude mcp add --transport http distribute.you https://mcp.distribute.you/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

Claude Desktop, Cursor, and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "distribute.you": {
      "type": "http",
      "url": "https://mcp.distribute.you/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Call `distribute_status` first — it confirms the key reached the gateway, lists every organization the key reaches with its brands, and says what to fix if the key was refused. The API cannot tell a revoked key from a mistyped one; both come back as a refusal.

**What a key covers.** A key belongs to its user and reaches every organization that user is a member of (membership is checked on every request; distribute.you staff count as members of every organization). It never belongs to a single brand. A distribute.you staff user's key may also call the few staff operations the API opens to it (create an organization for a new client, add credit to an account); the API decides that on every call, and a client key never sees them.

**Naming the organization.** Each call acts in a single organization. The tools that read brand or campaign data take an optional `brandId` (which selects the organization holding that brand) and an optional `orgId` (add it when a brand sits in several organizations). Take both from `distribute_status`. A user in a single organization can omit them. A user in several who names nothing gets the API's refusal back unchanged, `org_target_required` with its `message`, `fix` and the `organizations` to choose from; the server never picks one. The other refusals come back the same way: `brand_in_several_orgs`, `brands_span_orgs`, `org_not_member`, `org_not_found`, `brand_not_found`, `no_organization`, `membership_unavailable`.

## Tools

There are **19 tools**. The list below is the whole surface; the `/.well-known` discovery document is built from the same definitions, so it always lists the same set.

**Same scope as the API.** Whatever your key can do on `https://api.distribute.you/v1/*`, it can do from here, and nothing more: the API decides on every call what the key may read or write, and this server never widens or narrows it. Our own internals (prompt text, models, token counts, generation costs, the internal service registry) never come back through it.

Get a key and pay, no human needed (the two signup tools work with no key):

| Tool | What it does |
|---|---|
| `distribute_signup_start` | Open an account: email + phone, a 6-digit code is emailed |
| `distribute_signup_complete` | Send the code, get an API key; the session uses it at once |
| `distribute_prepay` | Get a payment page to prepay (from $10, auto top-up required) |
| `distribute_prepaid_status` | Prepaid state, balance, auto top-up and card |

Curated tools, for the frequent jobs:

| Tool | What it does |
|---|---|
| `distribute_status` | Confirm the key works and list every organization it reaches, with their brands. `search` (a name or domain) narrows the list to matching organizations and brands; a key in more than 20 organizations gets them by name only until it searches. With no key, says how to get one |
| `distribute_list_brands` | The brands (companies, websites) of the organization a call targets |
| `distribute_list_workflows` | Available workflows, including ones written in a named expert's style. Which one runs on a step is never picked: the platform ranks them like a multi-armed bandit |
| `distribute_suggest_icp` | Read a brand's site and propose an ideal customer profile |
| `distribute_list_campaigns` | The campaigns of one brand or organization, with what starts each (`runsWhen`, `trigger`), what it does (`path`), type and limits, filterable by status |
| `distribute_campaign_stats` | One campaign's results, part by part, success first. Also takes the id of one step of a campaign and names that campaign |
| `distribute_list_leads` | A brand's leads and where each stands: sent, delivered, clicked, replied, bounced, with dates |
| `distribute_list_emails` | The emails we wrote for a brand: for each prospect, the first email and every follow-up, subject and body |
| `distribute_get_lead` | One lead in one call: who they are, where they stand, the emails written for them, and the whole conversation. Takes a lead's `id` or the person's `leadId` (with `campaignId`) |
| `distribute_list_triggers` | The entry doors a reactive campaign starts on, each with its `type` (`outcome` or `condition`), whether it is `callable`, and how to fire a callable one for a person (`distribute_call_api POST /v1/trigger-events`) |

The method, before acting on a client's ask:

| Tool | What it does |
|---|---|
| `distribute_list_skills` | The method skills our Copilot follows (offers and their documents, the catalogue, sales funnels, campaigns and their caps, triggers, billing, plays), each with when to read it |
| `distribute_read_skill` | One skill in full: the steps and the API operations to call, in order. Start with `index` |

The whole API, by intent:

| Tool | What it does |
|---|---|
| `distribute_find_api` | Search every API operation by what you want to do, in plain words ("set a campaign's max budget", "account balance") |
| `distribute_describe_api` | One operation in full: parameters, the JSON body it takes, and `answers`: what a successful call returns (per status, its JSON shape from the gateway's document, bounded; "Not documented" when the gateway states none) |
| `distribute_call_api` | Call any API operation with your key, reads and writes, answered exactly as the API answers |

**Why generic tools, and why they do not rot.** The three generic tools read the catalogue the API serves for the session's key (`https://api.distribute.you/v1/me/openapi.json`; the public `https://api.distribute.you/openapi.json` with no key or a refused one), checked against the gateway on every call (a HEAD for the document's ETag: the held copy is reused only while it is unchanged), so there is no staleness window. For a client key it lists every customer operation; for a staff user's key it adds the staff operations that key may call, marked `staffOnly`. So it is exactly that key's scope, one key's catalogue never answers another key's session, and a route the API adds is reachable from here on the very next call, with no new release of this server. `distribute_call_api` only calls operations of that catalogue.

**Emails and their status.** `distribute_list_emails` returns each written email with its `sequence`: one entry per step with `bodyText`, `kind` (`first_email` or `follow_up`) and its send `status` (`sent` at `sentAt`; `bounced`: it went out at `sentAt` but the receiving server refused it at `bouncedAt`, so the prospect never got it; `queued`: goes out in the prospect's business hours; or `stopped`: will not go out), joined from the API's `GET /v1/email-sequences` on `leadId` and step. So "every email we sent for my brand, with what is still queued" is one call. `distribute_get_lead` gives the same for one prospect.

**Two lead ids.** A lead row's `id` is the person on ONE campaign (what `GET /v1/leads/{id}` reads); its `leadId` is the PERSON (what a trigger event's `ranLeads[].leadId`, an email and a timeline name). `distribute_get_lead` takes either as `leadId` (older name `lead_id`): with the `campaignId` passed beside it (a trigger event's `ranLeads[].campaignId`), a person's id is read directly on that campaign (`GET /v1/campaigns/{campaignId}/leads/by-lead/{leadId}`, any campaign size; not on it yet = a clear "not a lead of that campaign"); with only a brandId it is looked up among the brand's newest 1,000 leads, then read by its row `id`. The answer's `note` says which lead row it is. If the status read is refused, the emails still come back, with the refusal in `sendStatusUnavailable`.

**Triggers: which ones a call may fire.** Outcome triggers (an outcome was just reached for a person: Form submitted, Meeting booked, Paid client) are callable: the fact often happens in the client's own tools, so an agent reports it. Condition triggers (an outcome + a delay + "still not" another, a GitHub issue in prod) are computed by us and never fired by a call. A new outcome or trigger is a feature request to the team, never created by a call (owner decision C1, 2026-10-15). features-service serves each trigger's `type` and `callable` (`GET /v1/public/channels` `triggers[]`, ~180 KB whole, which is why `distribute_list_triggers` exists rather than a generic call); campaign-service owns the door, `POST /v1/trigger-events`. Firing goes through the generic `distribute_call_api` (curated tools only read), which refuses a trigger with `callable: false` before calling. A new outcome or trigger is never created by a call: it is a feature request, filed with `POST /v1/staff-requests` (the `staff-requests` skill says what to write).

**What a campaign is.** A campaign is what the customer launched: one sales funnel run for one offer of a brand, started or paused as one, with its caps: a max budget and/or a max volume per period ("Max $10/day" when it reaches out on its own, "Up to $20/week" when it acts on what happens). `distribute_list_campaigns` lists those, and only those. Inside, a campaign runs one part per channel step; a part is never listed, counted or named as a campaign. Each campaign says what starts it, `runsWhen` ("Each time: Email Pushed Via API" plus its `trigger` {slug, name} for a reactive one, "On its own, within its caps (no trigger)" for a proactive one), and what it does, `path` (its steps in order), read from the dashboard's own Campaigns table copy (`GET /v1/features/brands/{brandId}/sales-funnel-campaigns?fields=copy`, one call per brand, no money computed). An agent reads the running campaigns before calling anything missing: one may already do what the client asks. If that read is refused, the campaigns still come back, each with `runsWhenUnavailableReason`.

**How stats read.** `distribute_campaign_stats` takes a campaign id from `distribute_list_campaigns` as `campaignId` (the older `campaign_id` still works) (an id seen elsewhere, such as in trigger events or offer stats, is one step of a campaign: it is accepted too, and the answer's `note` names the campaign it belongs to) and returns the campaign's name and status, a one-line `headline`, and `results`: one entry per part, named by the outcome it brings in (`outcome`, such as Positive reply or Lead; `bringsIn` is the older name of the same value) and the channel doing it (`channel`). Each entry leads with its own `headline` and a `summary`: meetings booked, positive replies, money earned and ROI (null for now: the API does not serve them, and `summary.notServed` says so), delivery rate (the ratio the API serves, shown as a percent; null when the API serves null), then volume and cost. The gateway's own figures follow unchanged, and bounces, unsubscribes and negative replies close the response in `failureDetails`. Zeros are shown as zeros. An assistant reading the response should report it in that order.

**The curated tools read; writes go through `distribute_call_api`.** No curated tool creates or stops a campaign: the customer dashboard has exactly one campaign write, at the end of onboarding, where billing is funded around it, and a one-click tool for it would land a campaign with no money and no audience. Any write the API allows your key (a campaign's caps, an offer, a campaign) is still reachable through `distribute_call_api`, exactly as through the API. An assistant is told to say what it is about to change before it calls a write.

## Running it locally

```bash
pnpm install
pnpm --filter "./shared/*" build
pnpm dev
```

`DISTRIBUTE_API_URL` overrides the gateway (defaults to `https://api.distribute.you`). The API key is never read from the environment — it arrives per request on the `Authorization` header, so one server serves many users.

`openapi.json` is generated by `pnpm generate:openapi`. Do not edit it by hand.
