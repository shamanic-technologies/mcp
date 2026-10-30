import { describe, it, expect, vi, afterEach } from "vitest";
import { callApi, runWithApiKey, KEY_REFUSED_SIGNUP } from "../src/lib/api-client.js";
import { handleToolCall, mintedKey } from "../src/tools/index.js";
import { newSessionKey, applyHeaderKey, noteKeyRefused, adoptMintedKey } from "../src/lib/session-key.js";

/**
 * 2026-10-31: agents copying the landing's `Authorization: Bearer distrib.usr_YOUR_KEY`
 * got "Invalid API key" with a dashboard hint and sent their human there, never
 * finding the keyless signup. A refused key now names it, and a signup in that
 * session wins over the refused header the client keeps re-sending.
 */
const PLACEHOLDER = "distrib.usr_YOUR_KEY";
const MINTED = "distrib.usr_new";
const GATEWAY_401 = {
  error: "Invalid API key",
  code: "key_not_recognized",
  message: "This key is not an active distribute.you key.",
  fix: "Copy the key again, or create a new one in the distribute.you dashboard (https://dashboard.distribute.you) under API keys.",
};

/** A fake gateway: the placeholder is refused, the minted key works, signup mints it. */
function fakeGateway() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/v1/agent-signups/complete")) {
      expect(auth).toBeNull();
      return json({ apiKey: MINTED, orgId: "o", userId: "u", created: true });
    }
    if (auth !== `Bearer ${MINTED}`) return json(GATEWAY_401, 401);
    if (url.includes("/v1/me")) return json({ user: { email: "a@x.com" }, organizations: [{ id: "o", name: "Acme", brands: [] }] });
    return json({ error: "not found" }, 404);
  });
}

afterEach(() => vi.restoreAllMocks());

/** One tool call, made the way src/index.ts makes it. */
async function call(session: ReturnType<typeof newSessionKey>, headerKey: string | null, tool: string, args: Record<string, unknown> = {}) {
  applyHeaderKey(session, headerKey);
  const result = await runWithApiKey(session.apiKey, () => handleToolCall(tool, args), tool, (k) => noteKeyRefused(session, k));
  const minted = mintedKey(tool, result);
  if (minted) await adoptMintedKey(session, minted, async (k) => (await callApi("/v1/me", { apiKey: k })).status === 401);
  return result as Record<string, any>;
}

describe("a session opened with a placeholder key", () => {
  it("distribute_status names the keyless signup tools", async () => {
    fakeGateway();
    const session = newSessionKey(PLACEHOLDER);
    const out = await call(session, PLACEHOLDER, "distribute_status");
    expect(out.status).toBe("error");
    const said = JSON.stringify(out);
    expect(said).toContain("distribute_signup_start");
    expect(said).toContain("distribute_signup_complete");
    expect(out.hint).toContain("No human needed");
    expect(out.hint).toContain("dashboard.distribute.you");
  });

  it("after signup_complete, distribute_status reports the new account, though the client still sends the placeholder", async () => {
    fakeGateway();
    const session = newSessionKey(PLACEHOLDER);
    expect((await call(session, PLACEHOLDER, "distribute_status")).status).toBe("error");
    await call(session, PLACEHOLDER, "distribute_signup_complete", { email: "a@x.com", code: "123456" });
    const out = await call(session, PLACEHOLDER, "distribute_status");
    expect(out.status).toBe("connected");
    expect(out.organizations).toEqual([{ id: "o", name: "Acme", brands: [] }]);
  });

  it("adopts the minted key even when signup is the first call", async () => {
    fakeGateway();
    const session = newSessionKey(PLACEHOLDER);
    await call(session, PLACEHOLDER, "distribute_signup_complete", { email: "a@x.com", code: "123456" });
    expect((await call(session, PLACEHOLDER, "distribute_status")).status).toBe("connected");
  });
});

describe("a session whose key works", () => {
  it("keeps its key after a signup", async () => {
    const session = newSessionKey("good");
    await adoptMintedKey(session, MINTED, async () => false);
    expect(session.apiKey).toBe("good");
  });

  it("a new header still replaces the key", () => {
    const session = newSessionKey("good");
    applyHeaderKey(session, "other");
    expect(session.apiKey).toBe("other");
  });

  it("a session with no key adopts without asking the gateway", async () => {
    const session = newSessionKey(null);
    const probe = vi.fn(async () => true);
    await adoptMintedKey(session, MINTED, probe);
    expect(session.apiKey).toBe(MINTED);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("any tool given a refused key", () => {
  it("keeps the gateway's refusal and adds the signup steps", async () => {
    fakeGateway();
    const res = await runWithApiKey(PLACEHOLDER, () => callApi("/v1/me"));
    expect(res.status).toBe(401);
    expect(res.errorBody).toMatchObject({ ...GATEWAY_401, signUpInstead: KEY_REFUSED_SIGNUP });
  });

  it("a failing curated tool carries the signup steps in its error", async () => {
    fakeGateway();
    const err = await runWithApiKey(PLACEHOLDER, () => handleToolCall("distribute_list_brands", {})).catch((e: Error) => JSON.parse(e.message));
    expect(err.code).toBe("key_not_recognized");
    expect(err.signUpInstead).toContain("distribute_signup_start");
  });
});
