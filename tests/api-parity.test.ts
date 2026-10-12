import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
  runWithApiKey: vi.fn((_k: unknown, fn: () => unknown) => fn()),
}));

import { handleToolCall, toolDefinitions, MAX_RESULT_CHARS } from "../src/tools/index.js";
import { callApi } from "../src/lib/api-client.js";
import { loadCatalogFromDocument, resetCatalog, searchOperations, matchPath, getCatalog } from "../src/lib/gateway-catalog.js";

const mockCallApi = vi.mocked(callApi);

const op = (summary: string, extra: Record<string, unknown> = {}) => ({
  tags: [extra.tag ?? "Misc"],
  summary,
  description: (extra.description as string) ?? "",
  operationId: extra.operationId ?? summary.replace(/\W+/g, "_"),
  security: [{ bearerAuth: [] }],
  parameters: extra.parameters ?? [],
  responses: {},
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
    "/v1/prompts": { get: op("Get prompt", { tag: "Prompts" }) },
    "/v1/content/platform-prompts": { get: op("List platform prompts", { tag: "Content" }) },
    "/v1/platform/services": { get: op("List services", { tag: "Platform" }) },
  },
  components: { schemas: { Budget: { type: "object", properties: { dailyBudgetCents: { type: "integer" } } } } },
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

  it("is re-read from the gateway once its copy is older than the TTL, so a new route appears with no release", async () => {
    resetCatalog();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ paths: { "/v1/brand-new-route": { get: op("Brand new route") } } }), { status: 200 }),
    );
    const { operations } = await getCatalog();
    expect(fetchSpy).toHaveBeenCalledWith("https://api.distribute.you/openapi.json", expect.anything());
    expect(operations.map((o) => o.path)).toEqual(["/v1/brand-new-route"]);
    fetchSpy.mockRestore();
  });

  it("fails loudly when it has never been read, instead of claiming the API has no routes", async () => {
    resetCatalog();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 502 }));
    await expect(getCatalog()).rejects.toThrow(/Could not read the API catalogue/);
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
    expect(mockCallApi).toHaveBeenCalledWith("/v1/brands/b1/daily-budget?orgId=o1", { method: "PATCH", body: { dailyBudgetCents: 1000 } });
    expect(res).toEqual({ operation: "PATCH /v1/brands/{brandId}/daily-budget", status: 200, data: { ok: true } });
  });

  it("merges an inline query string with `query` and adds the brand target", async () => {
    mockCallApi.mockResolvedValue({ data: { emails: [] }, status: 200 });
    await handleToolCall("distribute_call_api", { method: "GET", path: "/v1/emails?limit=5", query: { offset: 10 }, brandId: "b1" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/emails?limit=5&offset=10&brandId=b1", { method: "GET", body: undefined });
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
    sendStatus: "sent", // a field the API adds later passes through untouched
  };

  it("gives every step's text, no internals, and passes new fields through", async () => {
    mockCallApi.mockResolvedValue({ data: { emails: [email] }, status: 200 });
    const res = (await handleToolCall("distribute_list_emails", { brandId: "b1", orgId: "o1", limit: 1 })) as { emails: Array<Record<string, unknown>>; nextOffset: number };
    expect(mockCallApi).toHaveBeenCalledWith("/v1/emails?brandId=b1&limit=1&offset=0&orgId=o1");
    expect(res.emails[0]).toEqual({
      id: "e1",
      leadId: "L1",
      subject: "skip the warmup",
      bodyText: "Hi",
      sequence: [
        { step: 1, bodyText: "Hi", daysSinceLastStep: 0 },
        { step: 2, bodyText: "Following up", daysSinceLastStep: 3 },
      ],
      sendStatus: "sent",
    });
    expect(res.nextOffset).toBe(1);
  });
});

describe("one lead", () => {
  it("returns the lead, its written emails and its conversation, and reports a refused part in place", async () => {
    mockCallApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/leads/r1")) {
        return { data: { leadDetail: { id: "r1", leadId: "L1", email: "a@b.co", campaignId: "c1", brandIds: ["b1"], sent: true, opened: true, lead: { name: "Ann" } } }, status: 200 };
      }
      if (path.startsWith("/v1/emails/by-lead/L1")) return { data: { generation: { id: "e1", subject: "Hi", promptRaw: "x" } }, status: 200 };
      if (path.startsWith("/v1/conversations")) {
        return { error: "thread_unavailable", status: 502, errorBody: { error: "thread_unavailable", code: "thread_unavailable" } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const res = (await handleToolCall("distribute_get_lead", { lead_id: "r1", orgId: "o1" })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/emails/by-lead/L1?brandId=b1&campaignId=c1&orgId=o1");
    expect(mockCallApi).toHaveBeenCalledWith("/v1/conversations?campaign_id=c1&email=a%40b.co&brandId=b1&orgId=o1");
    expect(res.lead).toMatchObject({ id: "r1", email: "a@b.co", sent: true, person: { name: "Ann" } });
    expect(res.lead).not.toHaveProperty("opened");
    expect(res.emailsWritten).toEqual({ id: "e1", subject: "Hi" });
    expect(res.conversation).toBeNull();
    expect(res.conversationUnavailable).toEqual({ error: "thread_unavailable", code: "thread_unavailable" });
  });
});

describe("tool names say what they are for", () => {
  it("exposes the curated jobs and the generic trio", () => {
    for (const name of ["distribute_list_leads", "distribute_list_emails", "distribute_get_lead", "distribute_find_api", "distribute_describe_api", "distribute_call_api"]) {
      expect(toolDefinitions).toHaveProperty(name);
    }
  });
});
