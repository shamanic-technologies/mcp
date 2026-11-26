import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  headApi: vi.fn(async () => ({ status: 200, etag: null })),
  setApiKey: vi.fn(),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
}));

import { handleToolCall, toolDefinitions, llmSourceOf, routineFor, structuredValue, ROUTINE_RUNNER } from "../src/tools/index.js";
import { callApi } from "../src/lib/api-client.js";

const mockCallApi = vi.mocked(callApi);

beforeEach(() => {
  vi.clearAllMocks();
});

/** Answer each gateway path with its fixture; any other path fails the test loudly. */
function routes(map: Record<string, unknown>) {
  mockCallApi.mockImplementation((async (path: string, opts?: { method?: string }) => {
    const key = `${opts?.method ?? "GET"} ${path}`;
    if (!(key in map)) throw new Error(`unexpected call ${key}`);
    const v = map[key];
    return v && typeof v === "object" && "status" in (v as object) ? v : { data: v };
  }) as never);
}

describe("llmSourceOf", () => {
  it("is the founder's Claude when declared, their own key when anthropic is on org, else ours", () => {
    expect(llmSourceOf(true, [{ provider: "anthropic", keySource: "org" }])).toBe("claude_subscription");
    expect(llmSourceOf(false, [{ provider: "anthropic", keySource: "org" }])).toBe("own_key");
    expect(llmSourceOf(false, [{ provider: "openai", keySource: "org" }])).toBe("ours");
    expect(llmSourceOf(false, [])).toBe("ours");
  });
});

describe("distribute_set_llm_source", () => {
  it("claude_subscription declares the org local and hands back the hourly routine to create", async () => {
    routes({ "POST /v1/billing/accounts/solo_plan/enroll?orgId=org-1": { plan: "free" }, "PUT /v1/local-llm?orgId=org-1": { declared: true, pendingCalls: 3 } });
    const out = (await handleToolCall("distribute_set_llm_source", { source: "claude_subscription", orgId: "org-1" })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/local-llm?orgId=org-1", { method: "PUT", body: { enabled: true } });
    expect(out.source).toBe("claude_subscription");
    expect(out.pendingCalls).toBe(3);
    expect(out.plan).toEqual({ onPlan: true });
    expect(out.routine.every).toBe("hour");
    expect(out.routine.prompt).toContain("orgId org-1");
    expect(out.routine.prompt).toContain("distribute_llm_work_claim");
    expect(out.routine.prompt).toContain("distribute_llm_work_result");
    expect(out.routine.confirmation).toMatch(/one|once/);
    expect(JSON.stringify(out)).not.toMatch(/dashboard/i);
  });

  it("own_key refuses with a named fix when the org has no key for that provider", async () => {
    routes({ "POST /v1/billing/accounts/solo_plan/enroll": { plan: "free" }, "GET /v1/keys": { keys: [] } });
    await expect(handleToolCall("distribute_set_llm_source", { source: "own_key" })).rejects.toThrow(/key_missing.*distribute_set_key/);
  });

  it("own_key stops the local declaration and puts the provider on the org's key", async () => {
    routes({
      "POST /v1/billing/accounts/solo_plan/enroll": { status: 409, error: "existing_paying_org", errorBody: { error: "existing_paying_org", code: "existing_paying_org" } },
      "GET /v1/keys": { keys: [{ provider: "anthropic", maskedKey: "sk-…AAAA" }] },
      "PUT /v1/local-llm": { declared: false },
      "PUT /v1/keys/anthropic/source": { provider: "anthropic", keySource: "org" },
    });
    const out = (await handleToolCall("distribute_set_llm_source", { source: "own_key" })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/local-llm", { method: "PUT", body: { enabled: false } });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/keys/anthropic/source", { method: "PUT", body: { keySource: "org" } });
    expect(out).toMatchObject({ source: "own_key", provider: "anthropic", plan: { onPlan: false, keptOffer: "existing_paying_org" } });
  });

  it("ours stops the local declaration and puts anthropic back on the platform key", async () => {
    routes({ "POST /v1/billing/accounts/solo_plan/enroll": { plan: "free" }, "PUT /v1/local-llm": { declared: false }, "PUT /v1/keys/anthropic/source": {} });
    await handleToolCall("distribute_set_llm_source", { source: "ours" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/keys/anthropic/source", { method: "PUT", body: { keySource: "platform" } });
  });

  it("an unknown source is refused before any call", async () => {
    await expect(handleToolCall("distribute_set_llm_source", { source: "gpt" })).rejects.toThrow(/unknown_source/);
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});

describe("distribute_llm_source", () => {
  it("reads the declaration, the key sources and the masked keys", async () => {
    routes({
      "GET /v1/local-llm?brandId=b-1": { declared: true, pendingCalls: 2, runner: { connected: false, lastSeenAt: null } },
      "GET /v1/keys/sources?brandId=b-1": { sources: [] },
      "GET /v1/keys?brandId=b-1": { keys: [{ provider: "apollo", maskedKey: "ab…cd", createdAt: "x" }] },
    });
    const out = (await handleToolCall("distribute_llm_source", { brandId: "b-1" })) as Record<string, any>;
    expect(out.source).toBe("claude_subscription");
    expect(out.pendingCalls).toBe(2);
    expect(out.keys).toEqual([{ provider: "apollo", maskedKey: "ab…cd" }]);
    expect(out.routine.prompt).toContain("brandId b-1");
  });
});

describe("distribute_campaign_keys", () => {
  it("reads the campaign's needed keys and names the missing musts", async () => {
    routes({
      "GET /v1/engines/meeting_booked/required-keys?campaignId=c-1&brandId=b-1": {
        outcome: "meeting_booked",
        campaignId: "c-1",
        ready: false,
        engines: [],
        keys: [
          { provider: "apollo", domain: "apollo.io", held: false, required: true, for: [] },
          { provider: "anthropic", domain: null, held: true, required: true, for: [] },
          { provider: "instantly", domain: null, held: false, required: false, for: [] },
        ],
      },
    });
    const out = (await handleToolCall("distribute_campaign_keys", { outcome: "meeting_booked", campaignId: "c-1", brandId: "b-1" })) as Record<string, any>;
    expect(out.missingRequired).toEqual(["apollo"]);
    expect(out.next).toContain("apollo");
    expect(out.ready).toBe(false);
  });

  it("refuses with no outcome, before any call", async () => {
    await expect(handleToolCall("distribute_campaign_keys", {})).rejects.toThrow(/missing_outcome/);
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});

describe("distribute_set_key", () => {
  it("saves the key, puts the provider on it, and never echoes the clear key", async () => {
    routes({
      "POST /v1/keys": { provider: "openai", maskedKey: "sk-…9999", message: "saved" },
      "PUT /v1/keys/openai/source": {},
    });
    const out = await handleToolCall("distribute_set_key", { provider: " OpenAI ", apiKey: "sk-secret-9999" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/keys", { method: "POST", body: { provider: "openai", apiKey: "sk-secret-9999" } });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/keys/openai/source", { method: "PUT", body: { keySource: "org" } });
    expect(JSON.stringify(out)).not.toContain("sk-secret-9999");
  });
});

describe("distribute_llm_work_claim / result", () => {
  it("claims without holding the call open by default, named as the routine", async () => {
    routes({ "POST /v1/local-llm/work/claim": { items: [] } });
    const out = (await handleToolCall("distribute_llm_work_claim", {})) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/local-llm/work/claim", { method: "POST", body: { max: 1, waitMs: 0, runner: ROUTINE_RUNNER } });
    expect(out.items).toEqual([]);
    expect(out.next).toMatch(/Stop/);
  });

  it("hands the item's claude block back untouched (its model and prompts are the founder's own work)", async () => {
    const item = { id: "i-1", leaseId: "l-1", kind: "complete", answerBy: "t", claude: { systemPrompt: "s", prompt: "p", jsonSchema: null, model: "claude-sonnet-5-5", tools: [] } };
    routes({ "POST /v1/local-llm/work/claim": { items: [item] } });
    const out = (await handleToolCall("distribute_llm_work_claim", { max: 10 })) as Record<string, any>;
    expect(out.items).toEqual([item]);
  });

  it("posts a structured answer given as a JSON string as that JSON", async () => {
    routes({ "POST /v1/local-llm/work/i-1/result": { ok: true } });
    await handleToolCall("distribute_llm_work_result", { id: "i-1", leaseId: "l-1", ok: true, model: "claude-opus-5-5", structured: "{\"verdict\":\"yes\"}" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/local-llm/work/i-1/result", {
      method: "POST",
      body: { leaseId: "l-1", ok: true, model: "claude-opus-5-5", structured: { verdict: "yes" } },
    });
  });

  it("never says handed back when the service stored the answer as failed", async () => {
    routes({ "POST /v1/local-llm/work/i-3/result": { status: 200, data: { stored: true, status: "failed", error: "unpriced model" } } });
    const out = (await handleToolCall("distribute_llm_work_result", { id: "i-3", leaseId: "l", ok: true, model: "m", text: "x" })) as Record<string, any>;
    expect(out.error).toBe("unpriced model");
    expect(out.next).toMatch(/NOT used/);
    expect(out.next).not.toMatch(/Handed back/);
  });

  it("relays an expired item's 410 whole", async () => {
    routes({ "POST /v1/local-llm/work/i-2/result": { status: 410, error: "gone", errorBody: { error: "expired" } } });
    await expect(handleToolCall("distribute_llm_work_result", { id: "i-2", leaseId: "l", ok: true, model: "m", text: "x" })).rejects.toThrow(/410.*expired/);
  });

  it("hands a long prompt back in parts, the rest read with distribute_llm_work_read, nothing cut", async () => {
    const long = "a".repeat(30_000) + "b".repeat(30_000) + "c".repeat(5);
    const item = { id: "i-9", leaseId: "l", kind: "judgment", answerBy: new Date(Date.now() + 600_000).toISOString(), claude: { systemPrompt: "s", prompt: long, jsonSchema: null, model: "m", tools: [] } };
    routes({ "POST /v1/local-llm/work/claim": { items: [item] } });
    const out = (await handleToolCall("distribute_llm_work_claim", {})) as Record<string, any>;
    const it0 = out.items[0];
    expect(it0.promptParts).toBe(3);
    expect(it0.claude.prompt).toBe("a".repeat(30_000));
    const p2 = (await handleToolCall("distribute_llm_work_read", { id: "i-9", part: 2 })) as Record<string, any>;
    const p3 = (await handleToolCall("distribute_llm_work_read", { id: "i-9", part: 3 })) as Record<string, any>;
    expect(it0.claude.prompt + p2.text + p3.text).toBe(long);
    expect(p3.next).toMatch(/last part/);
    await expect(handleToolCall("distribute_llm_work_read", { id: "i-9", part: 4 })).rejects.toThrow(/bad_part/);
    await expect(handleToolCall("distribute_llm_work_read", { id: "nope", part: 2 })).rejects.toThrow(/item_not_held/);
  });

  it("structuredValue keeps a non-JSON string as text", () => {
    expect(structuredValue("plain")).toBe("plain");
    expect(structuredValue("[1,2]")).toEqual([1, 2]);
  });
});

describe("tool texts", () => {
  it("never tells a founder to hand over a Claude login", () => {
    expect(toolDefinitions.distribute_set_llm_source.description).toMatch(/Never ask for or use a Claude login/);
    expect(JSON.stringify(routineFor({}))).not.toMatch(/token|password/i);
  });
});
