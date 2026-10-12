# distribute.you MCP

A remote [MCP](https://modelcontextprotocol.io) server for [distribute.you](https://distribute.you). Point any MCP client at it with your distribute.you API key and do from there everything the [distribute.you API](https://api.distribute.you/openapi.json) lets that key do: read brands, campaigns and their results, leads, the emails we wrote and sent with every follow-up, each prospect's conversation, and reach every other API operation (budgets, offers, audiences, billing, CRM...) by describing what you want.

It is a **remote HTTP server**, not an npx package. Nothing is published to npm and nothing is installed locally — a client connects over Streamable HTTP and authenticates with a header.

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

**What a key covers.** A key belongs to its user and reaches every organization that user is a member of (membership is checked on every request; distribute.you staff count as members of every organization). It never belongs to a single brand and never carries staff, admin or beta powers, even when its user has them.

**Naming the organization.** Each call acts in a single organization. The tools that read brand or campaign data take an optional `brandId` (which selects the organization holding that brand) and an optional `orgId` (add it when a brand sits in several organizations). Take both from `distribute_status`. A user in a single organization can omit them. A user in several who names nothing gets the API's refusal back unchanged, `org_target_required` with its `message`, `fix` and the `organizations` to choose from; the server never picks one. The other refusals come back the same way: `brand_in_several_orgs`, `brands_span_orgs`, `org_not_member`, `org_not_found`, `brand_not_found`, `no_organization`, `membership_unavailable`.

## Tools

There are **12 tools**. The list below is the whole surface; the `/.well-known` discovery document is built from the same definitions, so it always lists the same set.

**Same scope as the API.** Whatever your key can do on `https://api.distribute.you/v1/*`, it can do from here, and nothing more: the API decides on every call what the key may read or write, and this server never widens or narrows it. Our own internals (prompt text, models, token counts, generation costs, the internal service registry) never come back through it.

Curated tools, for the frequent jobs:

| Tool | What it does |
|---|---|
| `distribute_status` | Confirm the key works and list every organization it reaches, with their brands |
| `distribute_list_brands` | The brands (companies, websites) of the organization a call targets |
| `distribute_list_workflows` | Available workflows, including ones written in a named expert's style |
| `distribute_suggest_icp` | Read a brand's site and propose an ideal customer profile |
| `distribute_list_campaigns` | The campaigns of one brand or organization, with type and limits, filterable by status |
| `distribute_campaign_stats` | One campaign's results, part by part, success first |
| `distribute_list_leads` | A brand's leads and where each stands: sent, delivered, clicked, replied, bounced, with dates |
| `distribute_list_emails` | The emails we wrote for a brand: for each prospect, the first email and every follow-up, subject and body |
| `distribute_get_lead` | One lead in one call: who they are, where they stand, the emails written for them, and the whole conversation |

The whole API, by intent:

| Tool | What it does |
|---|---|
| `distribute_find_api` | Search every API operation by what you want to do, in plain words ("change the daily budget", "account balance") |
| `distribute_describe_api` | One operation in full: parameters and the JSON body it takes |
| `distribute_call_api` | Call any API operation with your key, reads and writes, answered exactly as the API answers |

**Why generic tools, and why they do not rot.** The three generic tools read the API's own published catalogue (`https://api.distribute.you/openapi.json`, re-read every 10 minutes). That catalogue lists every customer operation and leaves staff-only routes out, so it is exactly the API's scope; a route the API adds is reachable from here as soon as it is published, with no new release of this server. `distribute_call_api` only calls operations of that catalogue.

**Emails and their status.** `distribute_list_emails` returns each written email with its `sequence` (one entry per step: `bodyText`, `daysSinceLastStep`). Whether a lead was actually sent, delivered or replied is on `distribute_list_leads` and `distribute_get_lead` (`sent`, `delivered`, `replied`, `firstSentAt`...). Any field the API adds to an email later (a per-email send status, for instance) passes through as served.

**What a campaign is.** A campaign is what the customer launched: one brand, one offer, run or paused as one, with a max budget and a max volume ("Max $10/day" when it reaches out on its own, "Up to $1/day" when it acts on what happens). `distribute_list_campaigns` lists those, and only those. Inside, a campaign runs one part per channel step; a part is never listed, counted or named as a campaign.

**How stats read.** `distribute_campaign_stats` takes a campaign id from `distribute_list_campaigns` and returns the campaign's name and status, a one-line `headline`, and `results`: one entry per part, named by what it brings in (`bringsIn`, such as Positive reply or Lead found) and the channel doing it (`channel`). Each entry leads with its own `headline` and a `summary`: meetings booked, positive replies, money earned and ROI (null for now: the API does not serve them, and `summary.notServed` says so), delivery rate (the ratio the API serves, shown as a percent; null when the API serves null), then volume and cost. The gateway's own figures follow unchanged, and bounces, unsubscribes and negative replies close the response in `failureDetails`. Zeros are shown as zeros. An assistant reading the response should report it in that order.

**The curated tools read; writes go through `distribute_call_api`.** No curated tool creates or stops a campaign: the customer dashboard has exactly one campaign write, at the end of onboarding, where billing is funded around it, and a one-click tool for it would land a campaign with no money and no audience. Any write the API allows your key (a budget, an offer, a campaign) is still reachable through `distribute_call_api`, exactly as through the API. An assistant is told to say what it is about to change before it calls a write.

## Running it locally

```bash
pnpm install
pnpm --filter "./shared/*" build
pnpm dev
```

`DISTRIBUTE_API_URL` overrides the gateway (defaults to `https://api.distribute.you`). The API key is never read from the environment — it arrives per request on the `Authorization` header, so one server serves many users.

`openapi.json` is generated by `pnpm generate:openapi`. Do not edit it by hand.
