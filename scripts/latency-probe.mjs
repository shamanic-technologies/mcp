// find_api latency through the MCP: N calls, prints p50/p90/max (ms).
// Usage: MCP_URL=... KEY=... N=30 node scripts/latency-probe.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "latency-probe", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${process.env.KEY}` } } }));
const qs = ["list the emails sent for my brand", "account balance", "change the daily budget", "my leads", "pause a campaign"];
const t = [];
for (let i = 0; i < Number(process.env.N ?? 30); i++) {
  const s = performance.now();
  const r = await c.callTool({ name: "distribute_find_api", arguments: { query: qs[i % qs.length], limit: 3 } });
  if (r.isError) throw new Error(r.content[0].text);
  t.push(performance.now() - s);
}
t.sort((a, b) => a - b);
const p = (q) => Math.round(t[Math.min(t.length - 1, Math.floor(q * t.length))]);
console.log(`find_api n=${t.length} p50=${p(0.5)}ms p90=${p(0.9)}ms max=${Math.round(t[t.length - 1])}ms`);
await c.close();
