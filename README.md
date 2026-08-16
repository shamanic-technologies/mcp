# mcp-service

Remote MCP server for [distribute](https://distribute.you). Point any MCP client at it with an org API key and drive your distribute account from Claude, WhatsApp, OpenClaw, or anything else that speaks MCP.

It is an HTTP server (`StreamableHTTPServerTransport` over Express), not an npx package — there is nothing to install.

## Connect

1. Create an org API key at `https://dashboard.distribute.you/orgs/<orgId>/api-keys`.
2. Add the server to your MCP client:

```json
{
  "mcpServers": {
    "distribute": {
      "type": "http",
      "url": "https://mcp.distribute.you/mcp",
      "headers": { "Authorization": "Bearer <your-org-api-key>" }
    }
  }
}
```

The key is forwarded to the distribute API gateway as `Authorization: Bearer <key>` — the same scheme the dashboard hands out.

## Tools

| Tool | api-service endpoint |
|------|----------------------|
| `distribute_status` | `GET /v1/me` |
| `distribute_list_workflows` | `GET /v1/workflows` |
| `distribute_list_campaigns` | `GET /v1/campaigns` |
| `distribute_campaign_stats` | `GET /v1/campaigns/{id}/stats` |
| `distribute_stop_campaign` | `POST /v1/campaigns/{id}/stop` |
| `distribute_list_brands` | `GET /v1/brands` |
| `distribute_suggest_icp` | `POST /v1/brand/icp-suggestion` |

Campaign creation is not exposed: a distribute campaign is set up with the customer and must state the sales funnel it sells through, so there is no self-serve create path to call.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `DISTRIBUTE_API_URL` | `https://api.distribute.you` | distribute API gateway |
| `PORT` | `3000` | HTTP port |
| `SENTRY_DSN` | — | Error tracking |

## Scripts

| Script | What it does |
|--------|--------------|
| `pnpm dev` | Run locally with hot reload |
| `pnpm build` | `tsc` + regenerate `openapi.json` |
| `pnpm generate:openapi` | Regenerate `openapi.json` from the tool definitions |
| `pnpm test` | Vitest |

`openapi.json` is generated. Do not edit it by hand.
