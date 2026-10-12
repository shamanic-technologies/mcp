import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
}));

import { handleToolCall, toolDefinitions, mintedKey, PREPAY_MINIMUMS } from "../src/tools/index.js";
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
  it("posts the three amounts to the prepaid checkout and returns the payment url", async () => {
    mockCallApi.mockResolvedValue({ data: { url: "https://checkout.stripe.com/x", payment_mode: "prepaid" }, status: 200 });
    const result = (await handleToolCall("distribute_prepay", {
      topup_amount_cents: 1000,
      auto_topup_amount_cents: 1500,
      auto_topup_threshold_cents: 500,
    })) as Record<string, unknown>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/billing/accounts/prepaid_checkout", {
      method: "POST",
      body: { topup_amount_cents: 1000, auto_topup_amount_cents: 1500, auto_topup_threshold_cents: 500 },
    });
    expect(result.url).toBe("https://checkout.stripe.com/x");
  });

  it("a below-minimum amount comes back as amount_below_minimum, naming the field", async () => {
    mockCallApi.mockResolvedValue({
      error: "amount_below_minimum",
      errorBody: { error: "amount_below_minimum", code: "amount_below_minimum", field: "topup_amount_cents", minimum_cents: 1000, message: "At least $10" },
      status: 400,
    });
    const err = await thrown(
      handleToolCall("distribute_prepay", { topup_amount_cents: 500, auto_topup_amount_cents: 1500, auto_topup_threshold_cents: 500 }),
    );
    expect(err.error).toBe("amount_below_minimum");
    expect(err.field).toBe("topup_amount_cents");
  });

  it("prepaid status reads the gateway, with the caller's target", async () => {
    mockCallApi.mockResolvedValue({ data: { state: "awaiting_payment", balance_cents: "0" }, status: 200 });
    const result = await handleToolCall("distribute_prepaid_status", { orgId: "o1" });
    expect(mockCallApi).toHaveBeenCalledWith("/v1/billing/accounts/prepaid_status?orgId=o1");
    expect(result).toEqual({ state: "awaiting_payment", balance_cents: "0" });
  });

  it("the minimums the tools state are the owner's: $10 / $15 / $5", () => {
    expect(PREPAY_MINIMUMS).toEqual({ topup_amount_cents: 1000, auto_topup_amount_cents: 1500, auto_topup_threshold_cents: 500 });
    expect(toolDefinitions.distribute_prepay.description).toContain("No human needed");
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
