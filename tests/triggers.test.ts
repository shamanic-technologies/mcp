import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  headApi: vi.fn(async () => ({ status: 200, etag: null })),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
  runWithApiKey: vi.fn((_k: unknown, fn: () => unknown) => fn()),
}));

import { handleToolCall, toolDefinitions, TRIGGER_RULE, FIRE_TRIGGER_HOW } from "../src/tools/index.js";
import { callApi } from "../src/lib/api-client.js";
import { resetCatalog } from "../src/lib/gateway-catalog.js";

const mockCallApi = vi.mocked(callApi);

/** Trigger rows exactly as features-service serves them on GET /v1/public/channels (prod, 2026-10-15). */
const TRIGGERS = [
  { id: "signed_up", label: "Signup", description: "A prospect created an account.", icon: "user-plus", fromStep: "signup", firedBy: "lead-service", coded: false, origin: "code", kind: "event", params: null, type: "outcome", outcomeKey: "signup", callable: true },
  { id: "form_submitted", label: "Form submitted", description: "A prospect filled in a form.", icon: "clipboard-text", fromStep: "form_submitted", firedBy: "crm-service", coded: true, origin: "code", kind: "event", params: null, type: "outcome", outcomeKey: "form_submitted", callable: true },
  { id: "paid_client", label: "Paid client", description: "A prospect became a paying client.", icon: "currency-dollar", fromStep: "paid_client", firedBy: "crm-service", coded: false, origin: "code", kind: "event", params: null, type: "outcome", outcomeKey: "paid_client", callable: true },
  { id: "email_pushed_via_api", label: "Email Pushed Via API", description: "You pushed an email you wrote, to send as written.", icon: "code", fromStep: null, firedBy: "campaign-service", coded: true, origin: "declared", kind: "reported", params: { reportedBy: "api-service" }, type: "condition", outcomeKey: null, callable: true },
  { id: "signup_not_paid_24_hours", label: "Signup Not Paid In 24 Hours", description: "A person signed up and did not pay within 24 hours.", icon: "clock-countdown", fromStep: "signup", firedBy: "campaign-service", coded: true, origin: "declared", kind: "delay", params: { minutes: 1440, afterStep: "signup", unlessStep: "paid_client" }, type: "condition", outcomeKey: null, callable: false },
];

const channels = { data: { channels: [], funnels: [], triggers: TRIGGERS }, status: 200 };

beforeEach(() => {
  vi.clearAllMocks();
  resetCatalog();
});

describe("distribute_list_triggers", () => {
  it("lists each trigger with its type and whether a call may fire it, from the public catalogue", async () => {
    mockCallApi.mockResolvedValueOnce(channels);
    const res = (await handleToolCall("distribute_list_triggers", {})) as Record<string, any>;
    expect(mockCallApi).toHaveBeenCalledWith("/v1/public/channels", { public: true });
    expect(res.rule).toBe(TRIGGER_RULE);
    expect(res.howToFire).toBe(FIRE_TRIGGER_HOW);
    expect(res.callable.map((t: any) => t.id)).toEqual(["signed_up", "form_submitted", "paid_client", "email_pushed_via_api"]);
    expect(res.callable[1]).toEqual({ id: "form_submitted", name: "Form submitted", description: "A prospect filled in a form.", type: "outcome", outcome: "form_submitted", callable: true });
    expect(res.computedByUs).toEqual([
      {
        id: "signup_not_paid_24_hours",
        name: "Signup Not Paid In 24 Hours",
        description: "A person signed up and did not pay within 24 hours.",
        type: "condition",
        callable: false,
        followsFrom: { id: "signed_up", name: "Signup" },
      },
    ]);
    // Our internals (which service fires it) never leave.
    expect(JSON.stringify(res)).not.toContain("crm-service");
  });

  it("fails loudly when the catalogue serves a trigger without `callable`", async () => {
    mockCallApi.mockResolvedValueOnce({ data: { triggers: [{ id: "x", label: "X", type: "outcome" }] }, status: 200 });
    await expect(handleToolCall("distribute_list_triggers", {})).rejects.toThrow(/without id, type or callable/);
  });
});

describe("distribute_call_api on the trigger door", () => {
  const doc = {
    data: {
      paths: {
        "/v1/trigger-events": {
          post: { tags: ["Triggers"], summary: "Fire any trigger", operationId: "reportTriggerEvent", security: [{ bearerAuth: [] }], responses: {} },
        },
      },
    },
    status: 200,
  };

  it("refuses a condition trigger before the call, like distribute_fire_trigger", async () => {
    mockCallApi.mockResolvedValueOnce(doc).mockResolvedValueOnce(channels);
    await expect(
      handleToolCall("distribute_call_api", {
        method: "POST",
        path: "/v1/trigger-events",
        body: { triggerId: "signup_not_paid_24_hours", brandId: "b1", offerId: "o1", person: { email: "a@b.co" } },
      }),
    ).rejects.toThrow(/not_callable.*computed by us.*"reportInstead":\{"id":"signed_up","name":"Signup"/);
    expect(mockCallApi).toHaveBeenCalledTimes(2);
  });

  it("carries a callable trigger to the door unchanged", async () => {
    mockCallApi.mockResolvedValueOnce(doc).mockResolvedValueOnce(channels).mockResolvedValueOnce({ data: { event: { outcome: "skipped" } }, status: 201 });
    const res = (await handleToolCall("distribute_call_api", {
      method: "POST",
      path: "/v1/trigger-events",
      body: { triggerId: "form_submitted", brandId: "b1", offerId: "o1", person: { email: "a@b.co" } },
    })) as Record<string, any>;
    expect(mockCallApi).toHaveBeenLastCalledWith("/v1/trigger-events", expect.objectContaining({
      method: "POST",
      body: { triggerId: "form_submitted", brandId: "b1", offerId: "o1", person: { email: "a@b.co" } },
    }));
    expect(res.data).toEqual({ event: { outcome: "skipped" } });
  });
});

describe("the trigger rule is said in the tools' own words", () => {
  it("states it once, in each trigger tool", () => {
    expect(TRIGGER_RULE).toMatch(/Outcome triggers .* are callable/);
    expect(TRIGGER_RULE).toMatch(/Condition triggers computed by us .* never fired by a call/);
    expect(TRIGGER_RULE).toContain("fire only one with `callable: true`");
    expect(TRIGGER_RULE).toMatch(/new outcome or trigger is a feature request/);
    expect(toolDefinitions.distribute_list_triggers.description).toContain(TRIGGER_RULE);
    expect(toolDefinitions.distribute_list_triggers.description).toContain(FIRE_TRIGGER_HOW);
    expect(FIRE_TRIGGER_HOW).toContain("POST /v1/trigger-events");
    expect(toolDefinitions.distribute_find_api.description).toContain("distribute_list_triggers");
    expect(toolDefinitions.distribute_list_campaigns.description).toContain("distribute_list_triggers");
  });
});
