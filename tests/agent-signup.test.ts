import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  headApi: vi.fn(async () => ({ status: 200, etag: null })),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
}));

import { handleToolCall, toolDefinitions, mintedKey } from "../src/tools/index.js";
import { callApi, getConfigStatus } from "../src/lib/api-client.js";

const mockCallApi = vi.mocked(callApi);

beforeEach(() => {
  vi.clearAllMocks();
});

async function thrown(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    return JSON.parse((e as Error).message);
  }
  throw new Error("expected the tool to throw");
}

describe("agent signup, with no key", () => {
  it("start posts email and phone to the public route, with no key", async () => {
    mockCallApi.mockResolvedValue({ data: { email: "a@x.com", expiresAt: "t", codeTtlMinutes: 15, maxAttempts: 5 }, status: 200 });
    const result = (await handleToolCall("distribute_signup_start", { email: "a@x.com", phone: "+33612345678" })) as Record<string, unknown>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/agent-signups/start", {
      method: "POST",
      body: { email: "a@x.com", phone: "+33612345678" },
      public: true,
    });
    expect(result.email).toBe("a@x.com");
    expect(String(result.next)).toContain("distribute_signup_complete");
  });

  it("complete returns the key and how to use it", async () => {
    mockCallApi.mockResolvedValue({
      data: { apiKey: "distrib.usr_abc", orgId: "o", userId: "u", created: true, usage: "Bearer", prepay: { path: "/v1/billing/accounts/prepaid_checkout" } },
      status: 200,
    });
    const result = (await handleToolCall("distribute_signup_complete", { email: "a@x.com", code: "123456", keyName: "bot" })) as Record<string, unknown>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/agent-signups/complete", {
      method: "POST",
      body: { email: "a@x.com", code: "123456", keyName: "bot" },
      public: true,
    });
    expect(result.apiKey).toBe("distrib.usr_abc");
    expect(result.prepay).toEqual({ path: "/v1/billing/accounts/prepaid_checkout" });
    expect(JSON.stringify(result.useTheKey)).toContain("Authorization: Bearer <apiKey>");
    expect(mintedKey("distribute_signup_complete", result)).toBe("distrib.usr_abc");
  });

  it("only signup_complete can hand a session a key", () => {
    expect(mintedKey("distribute_call_api", { apiKey: "k" })).toBeNull();
    expect(mintedKey("distribute_signup_complete", { error: "x" })).toBeNull();
  });

  it("a wrong code comes back as the gateway's named refusal", async () => {
    mockCallApi.mockResolvedValue({
      error: "code_invalid",
      errorBody: { error: "code_invalid", message: "Wrong code", attemptsLeft: 4 },
      status: 400,
    });
    const err = await thrown(handleToolCall("distribute_signup_complete", { email: "a@x.com", code: "000000" }));
    expect(err).toEqual({ status: 400, error: "code_invalid", message: "Wrong code", attemptsLeft: 4 });
  });

  it("distribute_status with no key points to signup", async () => {
    vi.mocked(getConfigStatus).mockReturnValueOnce({ configured: false, apiUrl: "https://api.distribute.you" });
    const result = (await handleToolCall("distribute_status", {})) as { message: string; instructions: string[] };
    expect(result.message).toContain("No human needed");
    expect(result.instructions.join(" ")).toContain("distribute_signup_start");
    expect(result.instructions.join(" ")).toContain("distribute_signup_complete");
  });
});

describe("prepay", () => {
  // RELOAD-RULE-ONE-HOME-1118: billing-service is the ONE home of the reload rule. The
  // figures below are whatever billing answers in the mock, never a copy held here.
  const BILLING_MIN = 777;

  it("posts the first prepayment and the reload amount, never a threshold", async () => {
    mockCallApi.mockResolvedValue({ data: { url: "https://checkout.stripe.com/x", payment_mode: "prepaid" }, status: 200 });
    const result = (await handleToolCall("distribute_prepay", {
      topup_amount_cents: 2000,
      auto_topup_amount_cents: 1500,
      auto_topup_threshold_cents: 500,
    })) as Record<string, unknown>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/billing/accounts/prepaid_checkout", {
      method: "POST",
      body: { topup_amount_cents: 2000, auto_topup_amount_cents: 1500 },
    });
    expect(result.url).toBe("https://checkout.stripe.com/x");
  });

  it("a reload left out is left out: billing applies its own default", async () => {
    mockCallApi.mockResolvedValue({ data: { url: "https://checkout.stripe.com/d" }, status: 200 });
    await handleToolCall("distribute_prepay", { topup_amount_cents: 2000 });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/billing/accounts/prepaid_checkout", {
      method: "POST",
      body: { topup_amount_cents: 2000 },
    });
  });

  it("billing's below-minimum refusal comes back whole", async () => {
    mockCallApi.mockResolvedValue({
      error: "reload_below_minimum",
      errorBody: { error: "Each automatic reload adds at least the minimum", code: "reload_below_minimum", minimum_cents: BILLING_MIN },
      status: 400,
    });
    const err = await thrown(handleToolCall("distribute_prepay", { topup_amount_cents: 2000, auto_topup_amount_cents: 1 }));
    expect(err).toMatchObject({ status: 400, code: "reload_below_minimum", minimum_cents: BILLING_MIN });
  });

  it("prepaid status reads the gateway, with the caller's target", async () => {
    mockCallApi.mockResolvedValue({ data: { state: "awaiting_payment", balance_cents: "0" }, status: 200 });
    const result = await handleToolCall("distribute_prepaid_status", { orgId: "o1" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/billing/accounts/prepaid_status?orgId=o1");
    expect(result).toEqual({ state: "awaiting_payment", balance_cents: "0" });
  });

  it("no tool states a reload figure or a threshold of its own", () => {
    const prepay = toolDefinitions.distribute_prepay;
    expect(prepay.description).toContain("No human needed");
    expect(Object.keys(prepay.schema.shape)).not.toContain("auto_topup_threshold_cents");
    for (const name of ["distribute_prepay", "distribute_reload_rules", "distribute_set_reload_amount"] as const) {
      const d = toolDefinitions[name];
      const text = d.description + JSON.stringify(Object.values(d.schema.shape).map((f) => (f as { description?: string }).description));
      expect(text).not.toMatch(/\$\d/);
      expect(text).not.toMatch(/\b(500|1000|1500)\b/);
      expect(text.toLowerCase()).not.toContain("threshold");
    }
  });

  it("reload rules are read from billing, with the caller's target", async () => {
    const rules = { first_topup_minimum_cents: BILLING_MIN, reload_amount_minimum_cents: BILLING_MIN, reload_threshold_minimum_cents: 0, default_reload_amount_cents: BILLING_MIN, default_reload_threshold_cents: 0 };
    mockCallApi.mockResolvedValue({ data: rules, status: 200 });
    const result = await handleToolCall("distribute_reload_rules", { orgId: "o1" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/billing/accounts/reload_rules?orgId=o1");
    expect(result).toEqual(rules);
  });

  it("set reload amount PATCHes only the amount: no payment, no threshold", async () => {
    mockCallApi.mockResolvedValue({ data: { topup_amount_cents: 2500 }, status: 200 });
    await handleToolCall("distribute_set_reload_amount", { topup_amount_cents: 2500, orgId: "o1" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/billing/accounts/auto_topup?orgId=o1", {
      method: "PATCH",
      body: { topup_amount_cents: 2500 },
    });
  });

  it("set reload amount relays billing's topup_below_minimum refusal whole", async () => {
    mockCallApi.mockResolvedValue({
      error: "topup_below_minimum",
      errorBody: { error: "Each automatic reload adds at least the minimum", code: "topup_below_minimum", minimum_cents: BILLING_MIN },
      status: 400,
    });
    const err = await thrown(handleToolCall("distribute_set_reload_amount", { topup_amount_cents: 1 }));
    expect(err).toMatchObject({ status: 400, code: "topup_below_minimum", minimum_cents: BILLING_MIN });
  });
});

describe("402 payment_required", () => {
  const refusal = {
    error: "payment_required",
    errorBody: {
      error: "payment_required",
      code: "payment_required",
      message: "This call costs money...",
      prepay: { path: "/v1/billing/accounts/prepaid_checkout" },
    },
    status: 402,
  };

  it("a curated tool hands back the prepay instructions, not a generic error", async () => {
    mockCallApi.mockResolvedValue(refusal);
    const err = await thrown(handleToolCall("distribute_list_brands", {}));
    expect(err.status).toBe(402);
    expect(err.code).toBe("payment_required");
    expect(err.prepay).toEqual({ path: "/v1/billing/accounts/prepaid_checkout" });
    expect(String(err.nextStep)).toContain("distribute_prepay");
  });
});
