import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import {
  createOAuthRouter,
  decodeClientId,
  encodeClientId,
  isAllowedRedirectUri,
  pkceMatches,
  registerClient,
  wwwAuthenticate,
  keyNameFor,
  type SignupApi,
} from "../src/oauth.js";

/**
 * MCP-OAUTH-1125: claude.ai / ChatGPT connect with OAuth, the approval is the
 * agent-signup email link, and the app ends up holding the person's own API key.
 */
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(20) + "B".repeat(20) + "-._~1234";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let server: Server;
let base: string;
let api: { start: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn>; keyRefused: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  api = {
    start: vi.fn(async () => ({ ok: true, pollToken: "poll-1" })),
    complete: vi.fn(async () => ({ state: "pending" })),
    keyRefused: vi.fn(async () => false),
  };
  const app = express();
  app.use(express.json());
  app.use(createOAuthRouter(api as unknown as SignupApi));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

async function register(redirectUris = [CLAUDE_CALLBACK], name = "Claude"): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: name, token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeParams(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-42",
    ...extra,
  });
}

/** Walks the person's side: email typed, link clicked. Returns the redirect the page sends them to. */
async function approve(clientId: string): Promise<URL> {
  const form = authorizeParams(clientId);
  form.set("email", "Staff+OAuth@Distribute.you");
  const res = await fetch(`${base}/authorize`, { method: "POST", body: form });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Check your inbox");
  const id = /var id="([^"]+)"/.exec(html)![1];

  const pending = await (await fetch(`${base}/authorize/status?id=${id}`)).json();
  expect(pending).toEqual({ pending: true });

  api.complete.mockResolvedValueOnce({ state: "key", apiKey: "distrib.usr_marie" });
  const done = (await (await fetch(`${base}/authorize/status?id=${id}`)).json()) as { redirect: string };
  return new URL(done.redirect);
}

async function token(body: Record<string, string>) {
  const res = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("discovery", () => {
  it("points a client from the MCP resource to this authorization server", async () => {
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(pr.resource).toBe(`${base}/mcp`);
    expect(pr.authorization_servers).toEqual([base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("the 401 challenge names the protected-resource metadata", () => {
    expect(wwwAuthenticate("https://mcp.distribute.you")).toBe(
      'Bearer resource_metadata="https://mcp.distribute.you/.well-known/oauth-protected-resource"',
    );
    expect(wwwAuthenticate("https://mcp.distribute.you", "invalid_token")).toContain('error="invalid_token"');
  });
});

describe("client registration", () => {
  it("a client id carries its own redirect URIs, so it survives a deploy", () => {
    const id = encodeClientId({ redirectUris: [CLAUDE_CALLBACK], name: "Claude" });
    expect(decodeClientId(id)).toEqual({ redirectUris: [CLAUDE_CALLBACK], name: "Claude" });
    expect(decodeClientId("dy1.garbage")).toBeNull();
    expect(decodeClientId("someone-else")).toBeNull();
  });

  it("allows https and localhost http only", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(registerClient({ redirect_uris: ["http://evil.example/cb"] }).ok).toBe(false);
    expect(registerClient({}).ok).toBe(false);
  });
});

describe("authorize", () => {
  it("shows the app's name and asks only an email", async () => {
    const clientId = await register();
    const res = await fetch(`${base}/authorize?${authorizeParams(clientId)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connect Claude to distribute.you");
    expect(html).toContain('type="email"');
    expect(html).toContain("claude.ai");
  });

  it("an unknown client or redirect is shown to the person, never redirected", async () => {
    const res = await fetch(`${base}/authorize?${authorizeParams("nope")}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    const clientId = await register();
    const res2 = await fetch(`${base}/authorize?${authorizeParams(clientId, { redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
    expect(res2.status).toBe(400);
  });

  it("no PKCE goes back to the client as an error", async () => {
    const clientId = await register();
    const p = authorizeParams(clientId);
    p.delete("code_challenge");
    const res = await fetch(`${base}/authorize?${p}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("st-42");
  });

  it("the approval is the agent-signup email link: start, then poll until clicked", async () => {
    const clientId = await register();
    const back = await approve(clientId);
    expect(api.start).toHaveBeenCalledWith("staff+oauth@distribute.you");
    expect(api.complete).toHaveBeenCalledWith("staff+oauth@distribute.you", "poll-1", keyNameFor({ redirectUris: [], name: "Claude" }));
    expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("state")).toBe("st-42");
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  it("concurrent polls mint one key only", async () => {
    const clientId = await register();
    const form = authorizeParams(clientId);
    form.set("email", "staff@distribute.you");
    const html = await (await fetch(`${base}/authorize`, { method: "POST", body: form })).text();
    const id = /var id="([^"]+)"/.exec(html)![1];
    let release!: () => void;
    api.complete.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ state: "key", apiKey: "distrib.usr_one" }))),
    );
    const a = fetch(`${base}/authorize/status?id=${id}`).then((r) => r.json());
    const b = fetch(`${base}/authorize/status?id=${id}`).then((r) => r.json());
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    const out = await Promise.all([a, b]);
    expect(api.complete).toHaveBeenCalledTimes(1);
    expect(out.some((o) => typeof (o as { redirect?: string }).redirect === "string")).toBe(true);
  });

  it("a refused email send is told on the page", async () => {
    api.start.mockResolvedValueOnce({ ok: false, message: "mail down" });
    const clientId = await register();
    const form = authorizeParams(clientId);
    form.set("email", "staff@distribute.you");
    const res = await fetch(`${base}/authorize`, { method: "POST", body: form });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("mail down");
  });
});

describe("token", () => {
  it("hands the client the person's own API key, with no expiry, once", async () => {
    const clientId = await register();
    const code = (await approve(clientId)).searchParams.get("code")!;
    const first = await token({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: CLAUDE_CALLBACK });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ access_token: "distrib.usr_marie", token_type: "Bearer", refresh_token: "distrib.usr_marie" });
    expect(first.body.expires_in).toBeUndefined();
    const again = await token({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId });
    expect(again).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("a wrong verifier gets nothing, and burns the code", async () => {
    const clientId = await register();
    const code = (await approve(clientId)).searchParams.get("code")!;
    const bad = await token({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: clientId });
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const good = await token({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId });
    expect(good.status).toBe(400);
  });

  it("refresh hands back a live key and refuses a revoked one", async () => {
    const ok = await token({ grant_type: "refresh_token", refresh_token: "distrib.usr_marie" });
    expect(ok.body).toMatchObject({ access_token: "distrib.usr_marie" });
    api.keyRefused.mockResolvedValueOnce(true);
    const revoked = await token({ grant_type: "refresh_token", refresh_token: "distrib.usr_marie" });
    expect(revoked).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("PKCE S256 check", () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(pkceMatches("short", CHALLENGE)).toBe(false);
  });
});
