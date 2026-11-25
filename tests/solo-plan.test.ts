import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  headApi: vi.fn(async () => ({ status: 200, etag: null })),
  setApiKey: vi.fn(),
  getApiKey: vi.fn(() => "key-a"),
  isConfigured: vi.fn(() => true),
}));

import { handleToolCall, planWall, clearPlanCache, SOLO_PLAN_PATH, OUT_OF_CREDIT_TEXT, WALL_EXEMPT, toolDefinitions } from "../src/tools/index.js";
import { callApi, getApiKey } from "../src/lib/api-client.js";

const mockCallApi = vi.mocked(callApi);

const state = (over: Record<string, unknown> = {}) => ({
  org_id: "org-1",
  plan: "free",
  monthly_amount_cents: 9900,
  out_of_credit: false,
  out_of_credit_reason: null,
  upgrade_url: "https://distribute.you/upgrade",
  next_step: { action: "start_plan", method: "POST", path: "/v1/accounts/solo_plan/start", amount_cents: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPlanCache();
});

describe("the out-of-credit wall", () => {
  it("answers the fixed notice with the upgrade link, and never runs the tool", async () => {
    mockCallApi.mockResolvedValueOnce({ data: state({ out_of_credit: true, out_of_credit_reason: "debt_limit_reached" }) });
    const out = (await planWall("distribute_list_campaigns", {})) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledTimes(1);
    expect(mockCallApi).toHaveBeenCalledWith(SOLO_PLAN_PATH);
    expect(out.status).toBe("out_of_credit");
    expect(out.message).toBe(OUT_OF_CREDIT_TEXT.debt_limit_reached);
    expect(out.upgradeUrl).toBe("https://distribute.you/upgrade");
    expect(JSON.stringify(out)).not.toMatch(/dashboard/i);
  });

  it("every reason billing names has its fixed text", () => {
    for (const r of ["paid_plan_required", "debt_limit_reached", "trial_cap_reached", "credit_used_up", "payment_failed"]) {
      expect(OUT_OF_CREDIT_TEXT[r]).toBeTruthy();
      expect(OUT_OF_CREDIT_TEXT[r]).not.toMatch(/free credit|gift|dashboard/i);
    }
  });

  it("lets the tool run when the account has room", async () => {
    mockCallApi.mockResolvedValueOnce({ data: state() });
    expect(await planWall("distribute_list_campaigns", { brandId: "b-1" })).toBeNull();
    expect(mockCallApi).toHaveBeenCalledWith(`${SOLO_PLAN_PATH}?brandId=b-1`);
  });

  it("changes nothing for an account not on the plan (404), and remembers it for a minute", async () => {
    mockCallApi.mockResolvedValueOnce({ error: "not_enrolled", status: 404 });
    expect(await planWall("distribute_prepay", {})).toBeNull();
    expect(await planWall("distribute_list_leads", {})).toBeNull();
    expect(mockCallApi).toHaveBeenCalledTimes(1);
  });

  it("reads per key: another key's account is read on its own", async () => {
    mockCallApi.mockResolvedValue({ error: "not_enrolled", status: 404 });
    await planWall("distribute_list_leads", {});
    vi.mocked(getApiKey).mockReturnValueOnce("key-b");
    await planWall("distribute_list_leads", {});
    expect(mockCallApi).toHaveBeenCalledTimes(2);
  });

  it("lets the tool run when billing cannot be read now (billing still refuses at spend)", async () => {
    mockCallApi.mockResolvedValueOnce({ error: "upstream", status: 502 });
    expect(await planWall("distribute_list_leads", {})).toBeNull();
  });

  it("never walls the way in, the way out, or the founder's own Claude", async () => {
    for (const t of ["distribute_status", "distribute_start_plan", "distribute_add_plan_layer", "distribute_plan_status", "distribute_set_key", "distribute_set_llm_source", "distribute_llm_work_claim", "distribute_llm_work_result"]) {
      expect(WALL_EXEMPT.has(t)).toBe(true);
      expect(await planWall(t, {})).toBeNull();
    }
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("sends an account on the plan from the prepaid tools to the plan's tools", async () => {
    mockCallApi.mockResolvedValueOnce({ data: state({ plan: "active" }) });
    const out = (await planWall("distribute_prepay", {})) as Record<string, any>;
    expect(out.status).toBe("on_plan");
    expect(out.next).toContain("distribute_start_plan");
  });
});

describe("plan tools", () => {
  it("distribute_plan_status reads billing's state as served, with the notice when out of credit", async () => {
    mockCallApi.mockResolvedValueOnce({ data: state({ out_of_credit: true, out_of_credit_reason: "credit_used_up" }) });
    const out = (await handleToolCall("distribute_plan_status", { orgId: "org-1" })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith(`${SOLO_PLAN_PATH}?orgId=org-1`);
    expect(out.plan).toBe("free");
    expect(out.notice.message).toBe(OUT_OF_CREDIT_TEXT.credit_used_up);
  });

  it("distribute_start_plan hands the card page back", async () => {
    mockCallApi.mockResolvedValueOnce({ data: { ...state(), checkout_url: "https://checkout.stripe.com/x" } });
    const out = (await handleToolCall("distribute_start_plan", {})) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith(`${SOLO_PLAN_PATH}/start`, { method: "POST", body: { return_url: "https://distribute.you" } });
    expect(out.checkout_url).toBe("https://checkout.stripe.com/x");
    expect(out.next).toMatch(/checkout_url/);
  });

  it("distribute_start_plan relays billing's refusal whole", async () => {
    mockCallApi.mockResolvedValueOnce({ error: "card_hold_refused", status: 409, errorBody: { error: "card_hold_refused" } });
    await expect(handleToolCall("distribute_start_plan", {})).rejects.toThrow(/409.*card_hold_refused/);
  });

  it("distribute_add_plan_layer posts the layer and says it charges now", async () => {
    mockCallApi.mockResolvedValueOnce({ data: state({ plan: "active", monthly_amount_cents: 19900 }) });
    await handleToolCall("distribute_add_plan_layer", {});
    expect(mockCallApi).toHaveBeenCalledWith(`${SOLO_PLAN_PATH}/layers`, { method: "POST", body: {} });
    expect(toolDefinitions.distribute_add_plan_layer.description).toMatch(/charged NOW/);
    expect(toolDefinitions.distribute_add_plan_layer.description).toContain("$140");
  });
});
