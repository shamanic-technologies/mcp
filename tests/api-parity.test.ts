import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  headApi: vi.fn(async () => ({ status: 200, etag: null })),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
  runWithApiKey: vi.fn((_k: unknown, fn: () => unknown) => fn()),
}));

import { handleToolCall, toolDefinitions, MAX_RESULT_CHARS, MAX_ANSWER_SCHEMA_CHARS } from "../src/tools/index.js";
import { callApi, getApiKey, headApi } from "../src/lib/api-client.js";
import { loadCatalogFromDocument, resetCatalog, searchOperations, matchPath, getCatalog } from "../src/lib/gateway-catalog.js";

const mockCallApi = vi.mocked(callApi);

const op = (summary: string, extra: Record<string, unknown> = {}) => ({
  tags: [extra.tag ?? "Misc"],
  summary,
  description: (extra.description as string) ?? "",
  operationId: extra.operationId ?? summary.replace(/\W+/g, "_"),
  security: [{ bearerAuth: [] }],
  parameters: extra.parameters ?? [],
  responses: extra.responses ?? {},
  ...(extra.requestBody ? { requestBody: extra.requestBody } : {}),
});

/** A miniature of the gateway's served document: the shape the real one has. */
const DOC = {
  paths: {
    "/": { get: op("Root") },
    "/health": { get: op("Health") },
    "/v1/emails": {
      get: op("List generated emails by brand", {
        tag: "Emails",
        operationId: "listEmails",
        parameters: [{ name: "brandId", in: "query", required: true, schema: { type: "string" } }, { name: "x-org-id", in: "header", schema: { type: "string" } }],
      }),
    },
    "/v1/emails/by-lead/{leadId}": { get: op("Get the generated email for a lead", { tag: "Emails", parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string" } }] }) },
    "/v1/leads": { get: op("List leads", { tag: "Leads" }) },
    "/v1/leads/stats": { get: op("Lead stats", { tag: "Leads" }) },
    "/v1/leads/{id}": { get: op("Read one lead's full record", { tag: "Leads", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] }) },
    "/v1/leads/{id}/timeline": { get: op("One person's stored timeline", { tag: "Leads" }) },
    "/v1/conversations": { get: op("Read the messages exchanged with a lead on a campaign", { tag: "Conversations" }) },
    "/v1/billing/accounts/balance": { get: op("Get account balance", { tag: "Billing" }) },
    "/v1/brands/{brandId}/daily-budget": {
      get: op("Get a brand's daily budget", { tag: "Billing" }),
      patch: op("Set a brand's daily budget", {
        tag: "Billing",
        operationId: "setDailyBudget",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Budget" } } } },
      }),
    },
    // The old per-step daily ceiling, still served beside today's campaign caps.
    "/v1/brands/{brandId}/campaign-budget": { put: op("Set one campaign's daily budget", { tag: "Billing" }) },
    "/v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps": {
      get: op("Read a sales funnel's max budget + max volume and what it consumed this period", { tag: "Billing", operationId: "readCaps" }),
      put: op("State a sales funnel's MAX BUDGET and MAX VOLUME", {
        tag: "Billing",
        operationId: "stateCaps",
        description: "Body { maxBudget: {amountCents, period} | null, maxVolume: {count, period} | null }, period one_off | daily | weekly | monthly.",
      }),
    },
    "/v1/sales-funnel-campaigns/{id}": { patch: op("Run or pause the whole sales funnel campaign", { tag: "Campaigns" }) },
    "/v1/billing/accounts/monthly_charge_limit": { put: op("Set the monthly charge limit", { tag: "Billing" }) },
    "/v1/trigger-events": {
      post: op("Report a trigger event", {
        tag: "Triggers",
        operationId: "postV1TriggerEvents",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { triggerId: { type: "string" } } } } } },
        responses: {
          "200": { description: "Replayed", content: { "application/json": { schema: { $ref: "#/components/schemas/ReportTriggerEventResponse" } } } },
          "201": { description: "Recorded", content: { "application/json": { schema: { $ref: "#/components/schemas/ReportTriggerEventResponse" } } } },
          "400": { description: "Bad request", content: { "application/json": { schema: { type: "object" } } } },
        },
      }),
    },
    "/v1/campaigns/{id}/stream": {
      get: op("Stream a campaign's events", { tag: "Campaigns", operationId: "streamCampaign", responses: { "200": { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } } } }),
    },
    "/v1/huge": {
      get: op("A huge answer", { tag: "Misc", operationId: "huge", responses: { "200": { description: "Big", content: { "application/json": { schema: { $ref: "#/components/schemas/Huge" } } } } } }),
    },
    "/v1/prompts": { get: op("Get prompt", { tag: "Prompts" }) },
    "/v1/content/platform-prompts": { get: op("List platform prompts", { tag: "Content" }) },
    "/v1/platform/services": { get: op("List services", { tag: "Platform" }) },
  },
  components: {
    schemas: {
      Budget: { type: "object", properties: { dailyBudgetCents: { type: "integer" } } },
      ReportTriggerEventResponse: {
        type: "object",
        properties: { event: { $ref: "#/components/schemas/TriggerEvent" }, replayed: { type: "boolean" } },
        required: ["event", "replayed"],
      },
      TriggerEvent: {
        type: "object",
        properties: {
          id: { type: "string" },
          outcome: { type: "string", nullable: true, description: "`ran` | `skipped` | `failed`; null until done." },
          skipReason: { type: "string", nullable: true },
          ranCampaignIds: { type: "array", items: { type: "string" } },
        },
      },
      Huge: { type: "object", properties: { rows: { type: "array", items: { $ref: "#/components/schemas/HugeRow" } } } },
      HugeRow: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, { type: "string", description: "x".repeat(40) }])),
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetCatalog();
  loadCatalogFromDocument(DOC);
});

describe("the catalogue is the gateway's served document", () => {
  it("carries every customer operation and none of our internals or infrastructure", async () => {
    const { operations } = await getCatalog();
    const keys = operations.map((o) => `${o.method} ${o.path}`);
    expect(keys).toContain("GET /v1/emails");
    expect(keys).toContain("PATCH /v1/brands/{brandId}/daily-budget");
    for (const gone of ["GET /", "GET /health", "GET /v1/prompts", "GET /v1/content/platform-prompts", "GET /v1/platform/services"]) {
      expect(keys).not.toContain(gone);
    }
  });

  it("is read from the gateway the key is served, so a new route appears with no release", async () => {
    resetCatalog();
    mockCallApi.mockResolvedValue({ data: { paths: { "/v1/brand-new-route": { get: op("Brand new route") } } }, status: 200 });
    const { operations } = await getCatalog();
    expect(mockCallApi).toHaveBeenCalledWith("/v1/me/openapi.json", expect.objectContaining({ apiKey: "test-key" }));
    expect(operations.map((o) => o.path)).toEqual(["/v1/brand-new-route"]);
  });

  it("fails loudly when it has never been read, instead of claiming the API has no routes", async () => {
    resetCatalog();
    mockCallApi.mockResolvedValue({ error: "HTTP 502", status: 502 });
    await expect(getCatalog()).rejects.toThrow(/Could not read the API catalogue/);
  });
});

describe("the catalogue has no staleness window", () => {
  const docWith = (path: string) => ({ data: { paths: { [path]: { get: op(`Read ${path}`) } } }, status: 200 });
  const mockHead = () => vi.mocked(headApi);
  afterEach(() => {
    vi.mocked(headApi).mockReset();
    vi.mocked(headApi).mockImplementation(async () => ({ status: 200, etag: null }));
  });

  it("reuses the held copy only while the gateway's ETag for it is unchanged, checked on every call", async () => {
    resetCatalog();
    mockHead().mockResolvedValue({ status: 200, etag: 'W/"v1"' });
    mockCallApi.mockResolvedValue(docWith("/v1/one"));
    await getCatalog();
    await getCatalog();
    expect(mockHead()).toHaveBeenCalledTimes(2);
    expect(mockHead()).toHaveBeenCalledWith("/v1/me/openapi.json", expect.objectContaining({ apiKey: "test-key" }));
    expect(mockCallApi).toHaveBeenCalledTimes(1);
  });

  it("serves a route the gateway added on the very next call", async () => {
    resetCatalog();
    mockHead().mockResolvedValueOnce({ status: 200, etag: 'W/"v1"' }).mockResolvedValueOnce({ status: 200, etag: 'W/"v2"' });
    mockCallApi.mockResolvedValueOnce(docWith("/v1/one")).mockResolvedValueOnce(docWith("/v1/brand-new"));
    expect((await getCatalog()).operations.map((o) => o.path)).toEqual(["/v1/one"]);
    expect((await getCatalog()).operations.map((o) => o.path)).toEqual(["/v1/brand-new"]);
  });

  it("re-reads on every call when the gateway sends no ETag", async () => {
    resetCatalog();
    mockHead().mockResolvedValue({ status: 200, etag: null });
    mockCallApi.mockResolvedValue(docWith("/v1/one"));
    await getCatalog();
    await getCatalog();
    expect(mockCallApi).toHaveBeenCalledTimes(2);
  });

  it("never serves a copy it could not confirm current", async () => {
    resetCatalog();
    mockHead().mockResolvedValueOnce({ status: 200, etag: 'W/"v1"' }).mockResolvedValueOnce({ status: 502, etag: null, error: "HTTP 502" });
    mockCallApi.mockResolvedValue(docWith("/v1/one"));
    await getCatalog();
    await expect(getCatalog()).rejects.toThrow(/Could not read the API catalogue/);
  });

  it("checks the public document for a key the gateway refuses", async () => {
    resetCatalog();
    mockHead().mockResolvedValueOnce({ status: 401, etag: null, error: "HTTP 401" }).mockResolvedValueOnce({ status: 200, etag: 'W/"pub"' });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ paths: {} }), { status: 200 }));
    mockCallApi.mockResolvedValue({ error: "Invalid API key", status: 401 });
    await getCatalog();
    expect(mockHead()).toHaveBeenLastCalledWith("/openapi.json", expect.objectContaining({ apiKey: null }));
    fetchSpy.mockRestore();
  });
});

describe("finding a capability by intent", () => {
  it("answers 'list the emails sent for my brand' with the emails read", async () => {
    const { operations } = await getCatalog();
    expect(searchOperations(operations, "list the emails sent for my brand")[0]).toMatchObject({ method: "GET", path: "/v1/emails" });
  });

  it("maps a person's words onto the gateway's", async () => {
    const { operations } = await getCatalog();
    expect(searchOperations(operations, "what did the prospect reply")[0]!.path).toBe("/v1/conversations");
    expect(searchOperations(operations, "account balance")[0]!.path).toBe("/v1/billing/accounts/balance");
    expect(searchOperations(operations, "change the daily budget")[0]).toMatchObject({ method: "PATCH" });
  });

  it("finds a campaign's caps in today's words, ahead of the old per-step daily budget", async () => {
    const { operations } = await getCatalog();
    const caps = "/v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps";
    for (const ask of [
      "set a campaign's max budget",
      "change a campaign's max budget",
      "set the max budget and max volume of a campaign",
      "cap a campaign at 50 leads a week",
      "limit my campaign to 100 new people a month",
      "set my campaign to max $200 per month",
    ]) {
      expect(searchOperations(operations, ask)[0], ask).toMatchObject({ method: "PUT", path: caps });
    }
    expect(searchOperations(operations, "what are my campaign limits")[0], "read").toMatchObject({ path: caps });
    expect(searchOperations(operations, "pause a campaign")[0]!.path).toBe("/v1/sales-funnel-campaigns/{id}");
  });

  it("with no query, lists the areas of the API", async () => {
    const res = (await handleToolCall("distribute_find_api", {})) as { areas: Array<{ area: string }> };
    expect(res.areas.map((a) => a.area)).toEqual(expect.arrayContaining(["Leads", "Emails", "Billing"]));
  });

  it("describes an operation with its parameters and its body inlined", async () => {
    const res = (await handleToolCall("distribute_describe_api", { operationId: "setDailyBudget" })) as Record<string, unknown>;
    expect(res.path).toBe("/v1/brands/{brandId}/daily-budget");
    expect(res.body).toEqual({ type: "object", properties: { dailyBudgetCents: { type: "integer" } } });
    const listed = (await handleToolCall("distribute_describe_api", { operationId: "listEmails" })) as { parameters: Array<{ name: string }> };
    // Header plumbing is the gateway's, not a parameter the caller sets.
    expect(listed.parameters.map((p) => p.name)).toEqual(["brandId"]);
  });
});

describe("describe_api says what a successful call answers", () => {
  it("inlines each 2xx answer's shape from the served document", async () => {
    const res = (await handleToolCall("distribute_describe_api", { operationId: "postV1TriggerEvents" })) as {
      answers: Array<{ status: number; description: string; body: { properties: Record<string, { properties?: Record<string, unknown> }> } }>;
    };
    expect(res.answers.map((a) => a.status)).toEqual([200, 201]);
    const created = res.answers.find((a) => a.status === 201)!;
    expect(created.description).toBe("Recorded");
    expect(Object.keys(created.body.properties)).toEqual(["event", "replayed"]);
    expect(Object.keys(created.body.properties.event.properties!)).toEqual(["id", "outcome", "skipReason", "ranCampaignIds"]);
  });

  it("says nothing is documented when the gateway documents no success answer", async () => {
    const res = (await handleToolCall("distribute_describe_api", { operationId: "listEmails" })) as { answers: unknown };
    expect(res.answers).toMatch(/^Not documented by the gateway/);
  });

  it("names a non-JSON answer's media type instead of a shape", async () => {
    const res = (await handleToolCall("distribute_describe_api", { operationId: "streamCampaign" })) as { answers: Array<Record<string, unknown>> };
    expect(res.answers).toEqual([{ status: 200, description: "SSE stream", contentType: "text/event-stream", body: "Not JSON: text/event-stream." }]);
  });

  it("bounds a huge answer instead of flooding the context", async () => {
    const res = (await handleToolCall("distribute_describe_api", { operationId: "huge" })) as { answers: Array<{ body: unknown; note: string }> };
    expect(JSON.stringify(res.answers[0].body).length).toBeLessThanOrEqual(MAX_ANSWER_SCHEMA_CHARS);
    expect(res.answers[0].note).toMatch(/Large shape/);
    expect(JSON.stringify(res.answers[0].body)).toContain('"$ref":"HugeRow"');
  });
});

describe("matching a concrete path to its operation", () => {
  it("prefers the literal route over the parameter one, as the gateway's router does", async () => {
    const { operations } = await getCatalog();
    expect(matchPath(operations, "GET", "/v1/leads/stats")!.operation!.path).toBe("/v1/leads/stats");
    expect(matchPath(operations, "GET", "/v1/leads/abc")!.operation!.path).toBe("/v1/leads/{id}");
    expect(matchPath(operations, "GET", "/v1/leads/abc/timeline")!.operation!.path).toBe("/v1/leads/{id}/timeline");
  });
});

describe("distribute_call_api", () => {
  it("reaches a route no curated tool covers, with the caller's query, target and body", async () => {
    mockCallApi.mockResolvedValue({ data: { ok: true }, status: 200 });
    const res = (await handleToolCall("distribute_call_api", {
      method: "PATCH",
      path: "/v1/brands/b1/daily-budget",
      body: { dailyBudgetCents: 1000 },
      orgId: "o1",
    })) as Record<string, unknown>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/brands/b1/daily-budget?orgId=o1", {
      method: "PATCH",
      body: { dailyBudgetCents: 1000 },
      mcpTool: "distribute_call_api PATCH /v1/brands/{brandId}/daily-budget",
    });
    expect(res).toEqual({ operation: "PATCH /v1/brands/{brandId}/daily-budget", status: 200, data: { ok: true } });
  });

  it("merges an inline query string with `query` and adds the brand target", async () => {
    mockCallApi.mockResolvedValue({ data: { emails: [] }, status: 200 });
    await handleToolCall("distribute_call_api", { method: "GET", path: "/v1/emails?limit=5", query: { offset: 10 }, brandId: "b1" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/emails?limit=5&offset=10&brandId=b1", { method: "GET", body: undefined, mcpTool: "distribute_call_api GET /v1/emails" });
  });

  it("refuses a path the gateway does not serve to customers, and says where to look", async () => {
    await expect(handleToolCall("distribute_call_api", { method: "GET", path: "/internal/anything" })).rejects.toThrow(/not an operation of the distribute.you API/);
    await expect(handleToolCall("distribute_call_api", { method: "DELETE", path: "/v1/leads" })).rejects.toThrow(/not with DELETE/);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("never carries our internals: prompts, the service registry", async () => {
    for (const path of ["/v1/prompts", "/v1/content/platform-prompts", "/v1/platform/services", "/v1/platform/llm-context/x"]) {
      await expect(handleToolCall("distribute_call_api", { method: "GET", path })).rejects.toThrow(/not available through this server/);
    }
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("strips prompt, model, tokens, generation costs and opens from whatever the gateway answers", async () => {
    mockCallApi.mockResolvedValue({
      status: 200,
      data: {
        emails: [
          { id: "e1", subject: "Hi", promptRaw: "SECRET", responseRaw: "{}", variablesRaw: {}, model: "m", tokensInput: 1, tokensOutput: 2, promptType: "p", generationRun: { costs: [1] }, opened: true },
        ],
      },
    });
    const res = (await handleToolCall("distribute_call_api", { method: "GET", path: "/v1/emails", query: { brandId: "b1" } })) as { data: unknown };
    expect(res.data).toEqual({ emails: [{ id: "e1", subject: "Hi" }] });
  });

  it("hands back the gateway's refusal whole", async () => {
    mockCallApi.mockResolvedValue({ error: "Organization target required", status: 400, errorBody: { error: "Organization target required", code: "org_target_required", fix: "Add orgId" } });
    await expect(handleToolCall("distribute_call_api", { method: "GET", path: "/v1/leads" })).rejects.toThrow(/"status":400.*"code":"org_target_required"/);
  });

  it("does not drown the assistant in an oversized answer", async () => {
    mockCallApi.mockResolvedValue({ status: 200, data: { blob: "x".repeat(MAX_RESULT_CHARS + 10) } });
    const res = (await handleToolCall("distribute_call_api", { method: "GET", path: "/v1/leads" })) as Record<string, unknown>;
    expect(res.truncated).toBe(true);
    expect(String(res.fix)).toMatch(/fewer rows/);
  });
});

describe("the emails of a brand", () => {
  const email = {
    id: "e1",
    leadId: "L1",
    campaignId: "c1",
    subject: "skip the warmup",
    bodyText: "Hi",
    bodyHtml: "<p>Hi</p>",
    sequence: [
      { step: 1, bodyText: "Hi", bodyHtml: "<p>Hi</p>", daysSinceLastStep: 0 },
      { step: 2, bodyText: "Following up", bodyHtml: "<p>Following up</p>", daysSinceLastStep: 3 },
    ],
    promptRaw: "SECRET PROMPT",
    model: "some-model",
    tokensInput: 100,
    generationRun: { totalCostInUsdCents: "1" },
    extraField: "kept", // a field the API adds later passes through untouched
  };
  const sendRecord = {
    leadId: "L1",
    leadEmail: "ann@acme.co",
    campaignId: "c1",
    steps: [
      { step: 1, kind: "first_email", status: "sent", sentAt: "2026-10-12T07:00:00.000Z" },
      { step: 2, kind: "follow_up", status: "queued", sentAt: null },
    ],
  };
  const route = (seqPages: Array<Record<string, unknown>>, emails = [email]) => {
    let page = 0;
    mockCallApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/emails?")) return { data: { emails }, status: 200 };
      if (path.startsWith("/v1/email-sequences?")) return seqPages[page++] as never;
      throw new Error(`unexpected ${path}`);
    });
  };

  it("gives every step's text with its send status, joined on leadId and step, and no internals", async () => {
    route([{ data: { brandId: "b1", count: 1, nextCursor: null, sequences: [sendRecord] }, status: 200 }]);
    const res = (await handleToolCall("distribute_list_emails", { brandId: "b1", orgId: "o1", limit: 1 })) as { emails: Array<Record<string, unknown>>; nextOffset: number };
    expect(mockCallApi).toHaveBeenCalledWith("/v1/emails?brandId=b1&limit=1&offset=0&orgId=o1");
    expect(mockCallApi).toHaveBeenCalledWith("/v1/email-sequences?brandId=b1&limit=2000&orgId=o1");
    expect(res.emails[0]).toEqual({
      id: "e1",
      leadId: "L1",
      campaignId: "c1",
      leadEmail: "ann@acme.co",
      subject: "skip the warmup",
      bodyText: "Hi",
      sequence: [
        { step: 1, bodyText: "Hi", daysSinceLastStep: 0, kind: "first_email", status: "sent", sentAt: "2026-10-12T07:00:00.000Z" },
        { step: 2, bodyText: "Following up", daysSinceLastStep: 3, kind: "follow_up", status: "queued", sentAt: null },
      ],
      extraField: "kept",
    });
    expect(res.nextOffset).toBe(1);
  });

  it("pages the send records until every lead of the page is found", async () => {
    route([
      { data: { sequences: [{ ...sendRecord, leadId: "OTHER" }], nextCursor: "k1" }, status: 200 },
      { data: { sequences: [sendRecord], nextCursor: "k2" }, status: 200 },
    ]);
    const res = (await handleToolCall("distribute_list_emails", { brandId: "b1" })) as { emails: Array<{ sequence: Array<{ status: string }> }> };
    expect(mockCallApi).toHaveBeenCalledWith("/v1/email-sequences?brandId=b1&limit=2000&cursor=k1");
    // Found on page 2: page 3 (cursor k2) is never asked for.
    expect(mockCallApi).toHaveBeenCalledTimes(3);
    expect(res.emails[0]!.sequence.map((s) => s.status)).toEqual(["sent", "queued"]);
  });

  it("picks the sequence of the email's own campaign when a prospect was emailed twice", async () => {
    route([{ data: { sequences: [{ ...sendRecord, campaignId: "old", steps: [{ step: 1, kind: "first_email", status: "stopped", sentAt: null }] }, sendRecord], nextCursor: null }, status: 200 }]);
    const res = (await handleToolCall("distribute_list_emails", { brandId: "b1" })) as { emails: Array<{ sequence: Array<{ status: string }> }> };
    expect(res.emails[0]!.sequence[0]!.status).toBe("sent");
  });

  it("says plainly when a prospect has no send record yet", async () => {
    route([{ data: { sequences: [], nextCursor: null }, status: 200 }]);
    const res = (await handleToolCall("distribute_list_emails", { brandId: "b1" })) as { emails: Array<Record<string, unknown>> };
    expect(res.emails[0]!.sendStatusNote).toMatch(/No send record/);
  });

  it("still returns the emails when the status read is refused, and hands the refusal back whole", async () => {
    route([{ error: "boom", status: 500, errorBody: { error: "[instantly-service] email-sequences: unusable step 0" } }]);
    const res = (await handleToolCall("distribute_list_emails", { brandId: "b1" })) as Record<string, any>;
    expect(res.sendStatusUnavailable).toEqual({ status: 500, error: "[instantly-service] email-sequences: unusable step 0" });
    expect(res.emails[0].subject).toBe("skip the warmup");
    expect(res.emails[0].sendStatusNote).toMatch(/could not be read/);
  });
});

describe("one lead", () => {
  it("returns the lead, its written emails with their send status, and its conversation, and reports a refused part in place", async () => {
    mockCallApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/leads/r1")) {
        return { data: { leadDetail: { id: "r1", leadId: "L1", email: "a@b.co", campaignId: "c1", brandIds: ["b1"], sent: true, opened: true, lead: { name: "Ann" } } }, status: 200 };
      }
      if (path.startsWith("/v1/emails/by-lead/L1")) {
        return { data: { generation: { id: "e1", leadId: "L1", campaignId: "c1", subject: "Hi", promptRaw: "x", sequence: [{ step: 1, bodyText: "Hi" }] } }, status: 200 };
      }
      if (path.startsWith("/v1/email-sequences?")) {
        return { data: { sequences: [{ leadId: "L1", leadEmail: "a@b.co", campaignId: "c1", steps: [{ step: 1, kind: "first_email", status: "sent", sentAt: "t" }] }], nextCursor: null }, status: 200 };
      }
      if (path.startsWith("/v1/conversations")) {
        return { error: "thread_unavailable", status: 502, errorBody: { error: "thread_unavailable", code: "thread_unavailable" } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const res = (await handleToolCall("distribute_get_lead", { lead_id: "r1", orgId: "o1" })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/emails/by-lead/L1?brandId=b1&campaignId=c1&orgId=o1");
    expect(mockCallApi).toHaveBeenCalledWith("/v1/email-sequences?brandId=b1&limit=2000&orgId=o1");
    expect(mockCallApi).toHaveBeenCalledWith("/v1/conversations?campaign_id=c1&email=a%40b.co&brandId=b1&orgId=o1");
    expect(res.lead).toMatchObject({ id: "r1", email: "a@b.co", sent: true, person: { name: "Ann" } });
    expect(res.lead).not.toHaveProperty("opened");
    expect(res.emailsWritten).toEqual({
      id: "e1",
      leadId: "L1",
      campaignId: "c1",
      leadEmail: "a@b.co",
      subject: "Hi",
      sequence: [{ step: 1, bodyText: "Hi", kind: "first_email", status: "sent", sentAt: "t" }],
    });
    expect(res.conversation).toBeNull();
    expect(res.conversationUnavailable).toEqual({ error: "thread_unavailable", code: "thread_unavailable" });
  });
});

/**
 * MCP role-play 2026-10-14: a trigger event (POST /v1/trigger-events) names the person's lead in
 * `ranLeads[].leadId`, and get_lead answered "No lead ... here". That id is the PERSON (a list row's
 * `leadId`); GET /v1/leads/{id} reads the person ON ONE CAMPAIGN (a list row's `id`).
 */
describe("one lead, from the id a trigger event hands back", () => {
  const detail = { id: "row-9", leadId: "person-1", email: "a@b.co", campaignId: "u-push", brandIds: ["b1"], lead: { name: "Ann" } };
  function routeLead(listed: Array<Record<string, unknown>>) {
    mockCallApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/leads/row-9")) return { data: { leadDetail: detail }, status: 200 };
      if (path.startsWith("/v1/leads/")) return { error: "Lead not found", status: 404, errorBody: { error: "Lead not found" } };
      if (path.startsWith("/v1/leads?")) return { data: { leads: listed, nextCursor: null }, status: 200 };
      if (path.startsWith("/v1/emails/by-lead/")) return { data: { generation: null }, status: 200 };
      if (path.startsWith("/v1/conversations")) return { data: { conversation: { messages: [] } }, status: 200 };
      throw new Error(`unexpected ${path}`);
    });
  }

  it("finds the lead by the person's id on the campaign named beside it", async () => {
    routeLead([{ id: "row-other", leadId: "person-2", campaignId: "u-push" }, { id: "row-9", leadId: "person-1", campaignId: "u-push" }]);

    const res = (await handleToolCall("distribute_get_lead", { leadId: "person-1", campaignId: "u-push", orgId: "o1" })) as Record<string, any>;

    expect(mockCallApi).toHaveBeenCalledWith("/v1/leads?campaignId=u-push&view=compact&status=all&limit=200&orgId=o1");
    expect(mockCallApi).toHaveBeenCalledWith("/v1/leads/row-9?orgId=o1");
    expect(res.lead).toMatchObject({ id: "row-9", email: "a@b.co" });
    expect(res.note).toContain("person-1 is the person's id");
    expect(res.note).toContain("lead id row-9");
  });

  it("reads a lead row id directly, under `leadId` or the older `lead_id`", async () => {
    routeLead([]);
    const camel = (await handleToolCall("distribute_get_lead", { leadId: "row-9" })) as Record<string, any>;
    const snake = (await handleToolCall("distribute_get_lead", { lead_id: "row-9" })) as Record<string, any>;
    expect(camel.lead.id).toBe("row-9");
    expect(camel).not.toHaveProperty("note");
    expect(snake).toEqual(camel);
    expect(mockCallApi.mock.calls.some(([p]) => String(p).startsWith("/v1/leads?"))).toBe(false);
  });

  it("says which id it takes and where to get it, when the person id comes with no campaign", async () => {
    routeLead([]);
    await expect(handleToolCall("distribute_get_lead", { leadId: "person-1" })).rejects.toThrow("ranLeads[].campaignId");
  });

  it("says the person is not among the campaign's newest leads when the lookup finds nothing", async () => {
    routeLead([{ id: "row-other", leadId: "person-2", campaignId: "u-push" }]);
    await expect(handleToolCall("distribute_get_lead", { leadId: "person-1", campaignId: "u-push" })).rejects.toThrow(
      "not among the newest 1000 leads of that campaign",
    );
  });

  it("says both ids apart in the descriptions", () => {
    expect(toolDefinitions.distribute_get_lead.description).toContain("ranLeads[].leadId");
    expect(toolDefinitions.distribute_list_leads.description).toContain("distribute_get_lead takes it too");
  });
});

describe("tool names say what they are for", () => {
  it("exposes the curated jobs and the generic trio", () => {
    for (const name of ["distribute_list_leads", "distribute_list_emails", "distribute_get_lead", "distribute_find_api", "distribute_describe_api", "distribute_call_api"]) {
      expect(toolDefinitions).toHaveProperty(name);
    }
  });
});

/**
 * A staff user's key is served a few staff operations on top of the public ones
 * (`x-staff-only: true`); a client key and a session with no key never are.
 * The catalogue is cached per key, so one key's copy never answers another's.
 */
describe("each key searches the catalogue the gateway serves THAT key", () => {
  const staffOp = (summary: string, extra: Record<string, unknown> = {}) => ({ ...op(summary, { tag: "Staff (key)", ...extra }), "x-staff-only": true });
  const PUBLIC = { paths: { "/v1/billing/credits/grants": { get: op("Get the org's own credit-grants ledger", { tag: "Billing" }) } } };
  const STAFF = {
    paths: {
      ...PUBLIC.paths,
      "/v1/staff/orgs": { post: staffOp("Create an organization for a new client", { operationId: "createOrg" }) },
      "/v1/staff/orgs/{orgId}/credit-grants": { post: staffOp("Grant free credit to an organization", { operationId: "grantCredit" }) },
    },
  };
  const keyed = vi.mocked(getApiKey);
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetCatalog();
    mockCallApi.mockImplementation(async (_path: string, opts?: { apiKey?: string }) => {
      if (opts?.apiKey === "staff-key") return { data: STAFF, status: 200 };
      if (opts?.apiKey === "client-key") return { data: PUBLIC, status: 200 };
      return { error: "Invalid API key", status: 401 };
    });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(PUBLIC), { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    keyed.mockImplementation(() => "test-key");
  });

  const findAs = async (key: string | null, query: string) => {
    keyed.mockImplementation(() => key);
    return (await handleToolCall("distribute_find_api", { query })) as { matches: Array<{ operationId: string; staffOnly?: true }> };
  };

  it("a staff key finds 'grant free credit to an organization', marked staff-only", async () => {
    const res = await findAs("staff-key", "grant free credit to an organization");
    expect(res.matches[0]).toMatchObject({ operationId: "grantCredit", staffOnly: true });
    expect((await findAs("staff-key", "create an organization for a new client")).matches[0]!.operationId).toBe("createOrg");
  });

  it("a client key, served after a staff key, never sees a staff operation", async () => {
    await findAs("staff-key", "grant free credit");
    const res = await findAs("client-key", "grant free credit to an organization");
    expect(res.matches.map((m) => m.operationId)).not.toContain("grantCredit");
    expect(res.matches.every((m) => !m.staffOnly)).toBe(true);
  });

  it("a session with no key reads the public document", async () => {
    const res = await findAs(null, "grant free credit to an organization");
    expect(fetchSpy).toHaveBeenCalledWith("https://api.distribute.you/openapi.json", expect.anything());
    expect(res.matches.map((m) => m.operationId)).not.toContain("grantCredit");
  });

  it("a key the gateway refuses reads the public document", async () => {
    const res = await findAs("revoked-key", "grant free credit to an organization");
    expect(fetchSpy).toHaveBeenCalled();
    expect(res.matches.map((m) => m.operationId)).not.toContain("grantCredit");
  });

  it("a client key cannot call a staff path through distribute_call_api", async () => {
    keyed.mockImplementation(() => "client-key");
    await expect(handleToolCall("distribute_call_api", { method: "POST", path: "/v1/staff/orgs/o1/credit-grants", body: {} })).rejects.toThrow(/not an operation/);
  });

  it("describe_api says an operation is staff-only", async () => {
    keyed.mockImplementation(() => "staff-key");
    const res = (await handleToolCall("distribute_describe_api", { operationId: "grantCredit" })) as Record<string, unknown>;
    expect(res.staffOnly).toMatch(/staff key/);
  });
});

describe("plain words land the account operations a staff agent asks for", () => {
  const DOC2 = {
    paths: {
      "/v1/orgs/{orgId}/invitations": {
        post: op("Invite a person to the organization by email", { tag: "Organization", operationId: "invite" }),
        get: op("List pending invitations of the organization", { tag: "Organization", operationId: "listInvites" }),
      },
      "/v1/orgs/{orgId}/invitations/{id}": { delete: op("Revoke an invitation", { tag: "Organization", operationId: "revokeInvite" }) },
      "/v1/conversations": { get: op("Read the messages exchanged with a lead on a campaign", { tag: "Conversations", operationId: "readConversation" }) },
      "/v1/replies": { post: op("Reply to a person in their existing email thread", { tag: "Replies", operationId: "replyThread" }) },
      "/v1/leads": { get: op("List or search a brand's leads (find a lead by email, name or company)", { tag: "Leads", operationId: "leadByEmail" }) },
      "/v1/me": { get: op("Who am I acting as", { tag: "User", operationId: "me" }) },
      "/v1/me/openapi.json": { get: op("The API document for this key", { tag: "User", operationId: "meDoc" }) },
      "/v1/emails": { get: op("List generated emails by brand", { tag: "Emails", operationId: "listEmails" }) },
      "/v1/billing/credits/grants": { get: op("Get the org's own credit-grants ledger", { tag: "Billing", operationId: "grantsLedger" }) },
      "/v1/staff/orgs": { post: { ...op("Create an organization for a new client (staff only)", { tag: "Staff (key)", operationId: "createOrg" }), "x-staff-only": true } },
      "/v1/billing/credits/grant": { post: { ...op("Grant free credit to an organization (staff only)", { tag: "Staff (key)", operationId: "grantCredit" }), "x-staff-only": true } },
    },
  };
  const top = (q: string) => {
    resetCatalog();
    const { operations } = loadCatalogFromDocument(DOC2);
    return searchOperations(operations, q)[0]!.operationId;
  };

  it.each([
    ["invite a person to the organization", "invite"],
    ["list pending invitations", "listInvites"],
    ["revoke an invite", "revokeInvite"],
    ["create an organization", "createOrg"],
    ["grant free credit to an organization", "grantCredit"],
    ["reply to a person in the email thread", "replyThread"],
    ["what did the prospect reply", "readConversation"],
    ["find a lead by email", "leadByEmail"],
  ])("%s", (q, id) => {
    expect(top(q)).toBe(id);
  });
});
