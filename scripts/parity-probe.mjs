// Parity probe: the same key, the same questions, asked of the API directly and of
// the MCP server over Streamable HTTP. Prints a diff per job; exits 1 on any mismatch.
// Usage: MCP_URL=... API_URL=... KEY=... BRAND=... ORG=... node scripts/parity-probe.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { MCP_URL, API_URL, KEY, BRAND, ORG } = process.env;
const api = async (p) => {
  const r = await fetch(`${API_URL}${p}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`API ${p} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const client = new Client({ name: "parity-probe", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
};
let failed = 0;
const same = (label, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) failed++;
  console.log(`${ok ? "SAME" : "DIFF"}  ${label}`);
  if (!ok) console.log("  api:", JSON.stringify(a).slice(0, 400), "\n  mcp:", JSON.stringify(b).slice(0, 400));
};

const tools = await client.listTools();
console.log(`tools/list: ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);

// 1. brands
const apiBrands = await api(`/v1/brands?orgId=${ORG}`);
const mcpBrands = await call("distribute_list_brands", { orgId: ORG });
same(`brands (${apiBrands.brands.length}) ids+names`, apiBrands.brands.map((b) => [b.id, b.name]), mcpBrands.brands.map((b) => [b.id, b.name]));

// 2. leads of a brand (first page of 50)
const apiLeads = await api(`/v1/leads?brandId=${BRAND}&orgId=${ORG}&limit=50`);
const mcpLeads = await call("distribute_list_leads", { brandId: BRAND, orgId: ORG, limit: 50 });
const leadKey = (l) => [l.id, l.email, l.campaignId, l.sent, l.delivered, l.replied, l.replyClassification ?? null];
same(`leads page 1 (${apiLeads.leads.length}, total ${apiLeads.total}) id/email/campaign/sent/delivered/replied`, apiLeads.leads.map(leadKey), mcpLeads.leads.map(leadKey));
same("leads total + nextCursor", [apiLeads.total, apiLeads.nextCursor], [mcpLeads.total, mcpLeads.nextCursor]);

// 3. emails of a brand with every step's subject/body
const apiEmails = await api(`/v1/emails?brandId=${BRAND}&orgId=${ORG}&limit=20&offset=0`);
const mcpEmails = await call("distribute_list_emails", { brandId: BRAND, orgId: ORG, limit: 20 });
const emailKey = (e) => [e.id, e.leadId, e.subject, e.bodyText, (e.sequence ?? []).map((s) => [s.step, s.subject ?? null, s.bodyText, s.daysSinceLastStep])];
same(`emails page 1 (${apiEmails.emails.length}) id/lead/subject/body + every step`, apiEmails.emails.map(emailKey), mcpEmails.emails.map(emailKey));
// 3b. each step's send status, against GET /v1/email-sequences (joined on leadId + campaign + step)
const seqs = [];
for (let cursor = null, i = 0; i < 25; i++) {
  const page = await api(`/v1/email-sequences?brandId=${BRAND}&orgId=${ORG}&limit=2000${cursor ? `&cursor=${cursor}` : ""}`).catch((e) => ({ error: String(e) }));
  if (page.error) { console.log(`NOTE  email-sequences refused by the API: ${page.error.slice(0, 200)}`); break; }
  seqs.push(...page.sequences);
  cursor = page.nextCursor;
  if (!cursor) break;
}
if (seqs.length) {
  const counts = {};
  for (const q of seqs) for (const st of q.steps) counts[`${st.kind}:${st.status}`] = (counts[`${st.kind}:${st.status}`] ?? 0) + 1;
  console.log(`STATUS API counts for brand ${BRAND} (${seqs.length} sequences): ${JSON.stringify(counts)}`);
  const want = (e) => {
    const cands = seqs.filter((q) => q.leadId === e.leadId);
    const q = cands.find((c) => c.campaignId === e.campaignId) ?? (cands.length === 1 ? cands[0] : null);
    return (e.sequence ?? []).map((s) => { const st = q?.steps.find((x) => x.step === s.step); return [s.step, st?.status ?? null, st?.sentAt ?? null]; });
  };
  same("emails page 1 step status + sentAt", apiEmails.emails.map(want), mcpEmails.emails.map((e) => (e.sequence ?? []).filter((s) => s.bodyText !== null).map((s) => [s.step, s.status ?? null, s.sentAt ?? null])));
  const mc = {};
  for (const e of mcpEmails.emails) for (const s of e.sequence ?? []) mc[`${s.kind}:${s.status}`] = (mc[`${s.kind}:${s.status}`] ?? 0) + 1;
  console.log(`STATUS MCP list_emails page 1 step counts: ${JSON.stringify(mc)}`);
}
const leaked = JSON.stringify(mcpEmails).match(/"(promptRaw|responseRaw|variablesRaw|model|tokensInput|tokensOutput|generationRun|promptType)"/g);
console.log(`${leaked ? "LEAK" : "CLEAN"} internals in MCP emails: ${leaked ?? "none"}`);
if (leaked) failed++;

// 4. one lead's conversation (first lead that was sent)
const lead = apiLeads.leads.find((l) => l.sent) ?? apiLeads.leads[0];
const apiConv = await api(`/v1/conversations?campaign_id=${lead.campaignId}&email=${encodeURIComponent(lead.email)}&orgId=${ORG}`);
const mcpLead = await call("distribute_get_lead", { lead_id: lead.id, brandId: BRAND, orgId: ORG });
const msgKey = (m) => [m.direction, m.from, m.to, m.at, m.subject, m.text];
same(`conversation of ${lead.email} (${apiConv.conversation?.messages?.length} messages)`, apiConv.conversation.messages.map(msgKey), mcpLead.conversation.messages.map(msgKey));
const apiGen = (await api(`/v1/emails/by-lead/${lead.leadId}?brandId=${BRAND}&campaignId=${lead.campaignId}&orgId=${ORG}`)).generation;
same("that lead's written emails (by-lead)", apiGen && emailKey(apiGen), mcpLead.emailsWritten && emailKey(mcpLead.emailsWritten));

// 5. a route no curated tool covers, through the generic call
const found = await call("distribute_find_api", { query: "brand sending schedule" });
console.log("find_api 'list the emails sent for my brand' ->", (await call("distribute_find_api", { query: "list the emails sent for my brand", limit: 3 })).matches.map((m) => `${m.method} ${m.path}`).join(" | "));
console.log("find_api 'brand sending schedule' ->", found.matches.slice(0, 3).map((m) => `${m.method} ${m.path}`).join(" | "));
const apiTimeline = await api(`/v1/leads/${lead.id}/timeline?brandId=${BRAND}&orgId=${ORG}`);
const mcpTimeline = await call("distribute_call_api", { method: "GET", path: `/v1/leads/${lead.id}/timeline`, brandId: BRAND, orgId: ORG });
same(`generic call GET /v1/leads/{id}/timeline (uncurated)`, apiTimeline, mcpTimeline.data);

await client.close();
console.log(failed ? `FAILED: ${failed} mismatch(es)` : "ALL SAME");
process.exit(failed ? 1 : 0);
