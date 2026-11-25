/**
 * OAuth front door (MCP-OAUTH-1125): claude.ai, ChatGPT and any MCP client that
 * cannot hold a hand-typed header connect with OAuth, approve once, and then
 * every chat of theirs acts on the person's own distribute.you account.
 *
 * What the client app ends up holding IS a distribute.you API key of that
 * person: same org, same rights, revocable like any key (`DELETE
 * /v1/api-keys/{id}`, the key is named after the app). Nothing here is a second
 * credential or a second sign-up: the approval is the ONE agent-signup
 * mechanism (`/v1/agent-signups/start` emails an approval link, the page polls
 * `/v1/agent-signups/complete` with the poll token until the person clicked it,
 * owner 2026-11-25 « ON A UN MÉCANISME UNIQUE DE SIGNUP PAR MCP/API »). A new
 * email opens its account there, a known one gets one more key.
 *
 * Specs followed (what claude.ai and ChatGPT's connectors require):
 *  - MCP authorization 2025-06-18: a keyless request gets 401 with
 *    `WWW-Authenticate: Bearer resource_metadata=...` (RFC 9728).
 *  - RFC 8414 authorization server metadata, RFC 7591 dynamic client
 *    registration, OAuth 2.1 authorization code + PKCE S256 only.
 *
 * Stateless where a deploy would otherwise forget something that matters:
 *  - a client registration is its own id (`client_id` encodes its redirect URIs
 *    and name), so a client registered before a deploy still works after it;
 *  - the issued token is the API key itself, with no expiry, so a connector
 *    approved once works in every chat and after every deploy.
 * Only the few minutes between "Continue" and the redirect live in memory; a
 * deploy in that window means clicking "Connect" again.
 *
 * No key in a URL, no code typed by the person (owner 2026-11-25): the only
 * thing typed is the email, the proof is one click in that inbox.
 */
import { createHash, randomBytes } from "node:crypto";
import express, { Router, Request, Response } from "express";
import { callApi } from "./lib/api-client.js";
import { publicOrigin } from "./discovery.js";

/** How long a pending approval (email sent, not clicked yet) is kept. Matches nothing upstream: the link lives 24 h, a browser tab rarely does. */
export const PENDING_TTL_MS = 30 * 60_000;
/** An authorization code is redeemed by the client app within seconds (OAuth 2.1 advises at most 10 minutes). */
export const CODE_TTL_MS = 5 * 60_000;
const CLIENT_ID_PREFIX = "dy1.";

// ── Discovery ────────────────────────────────────────────────────────────────

export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

/** RFC 9728: where this MCP server sends a client to get a token. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_name: "distribute.you",
    resource_documentation: "https://distribute.you/docs",
  };
}

/** RFC 8414. Public clients with PKCE S256; the token never expires (it is the person's API key). */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["distribute"],
    service_documentation: "https://distribute.you/docs",
  };
}

/** The 401 a keyless MCP request gets: it starts the client's OAuth flow. */
export function wwwAuthenticate(origin: string, error?: "invalid_token"): string {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(origin)}"`];
  if (error) parts.push(`error="${error}"`, `error_description="The key was revoked or is not valid. Connect again."`);
  return `Bearer ${parts.join(", ")}`;
}

// ── Clients (RFC 7591), stateless ───────────────────────────────────────────

export interface OAuthClient {
  redirectUris: string[];
  name: string;
}

/** A redirect URI a client may register: https anywhere, http only on this machine (Claude Code, Cursor). */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return false;
}

export function encodeClientId(client: OAuthClient): string {
  return CLIENT_ID_PREFIX + Buffer.from(JSON.stringify({ r: client.redirectUris, n: client.name })).toString("base64url");
}

/** The client a `client_id` names, or null when it is not one of ours. */
export function decodeClientId(clientId: unknown): OAuthClient | null {
  if (typeof clientId !== "string" || !clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(clientId.slice(CLIENT_ID_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const r = (raw as { r?: unknown })?.r;
  const n = (raw as { n?: unknown })?.n;
  if (!Array.isArray(r) || r.length === 0 || !r.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) return null;
  if (typeof n !== "string") return null;
  return { redirectUris: r as string[], name: n };
}

/** RFC 7591 registration. Returns the client's answer, or an RFC 7591 error. */
export function registerClient(body: unknown):
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; error: string; error_description: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
    return { ok: false, error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array of URLs." };
  }
  const bad = (uris as string[]).find((u) => !isAllowedRedirectUri(u));
  if (bad) {
    return { ok: false, error: "invalid_redirect_uri", error_description: `Not allowed: ${bad}. Use https, or http on localhost.` };
  }
  const name = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim().slice(0, 80) : "Your AI app";
  const client: OAuthClient = { redirectUris: uris as string[], name };
  return {
    ok: true,
    response: {
      client_id: encodeClientId(client),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client: PKCE is the proof, there is no secret to keep.
      token_endpoint_auth_method: "none",
    },
  };
}

// ── Approval, via the agent-signup mechanism ────────────────────────────────

/** The gateway's agent-signup routes, injectable for tests. */
export interface SignupApi {
  /** Emails the approval link. */
  start(email: string): Promise<{ ok: true; pollToken: string } | { ok: false; message: string }>;
  /** One poll. `key` exactly once: each success mints a new key. */
  complete(email: string, pollToken: string, keyName: string): Promise<
    { state: "pending" } | { state: "key"; apiKey: string } | { state: "failed"; message: string }
  >;
  /** Whether the gateway refuses this key (revoked, unknown). */
  keyRefused(key: string): Promise<boolean>;
}

function errorMessage(body: Record<string, unknown> | undefined, fallback: string): string {
  const m = body?.message ?? body?.error;
  return typeof m === "string" && m ? m : fallback;
}

export const gatewaySignupApi: SignupApi = {
  async start(email) {
    const r = await callApi<{ pollToken?: unknown }>("/v1/agent-signups/start", { method: "POST", body: { email }, public: true });
    if (r.error || typeof r.data?.pollToken !== "string") {
      return { ok: false, message: errorMessage(r.errorBody as Record<string, unknown> | undefined, r.error ?? "No poll token came back.") };
    }
    return { ok: true, pollToken: r.data.pollToken };
  },
  async complete(email, pollToken, keyName) {
    const r = await callApi<{ apiKey?: unknown }>("/v1/agent-signups/complete", {
      method: "POST",
      body: { email, pollToken, keyName },
      public: true,
    });
    const body = r.errorBody as Record<string, unknown> | undefined;
    if (r.error) {
      if (body?.error === "authorization_pending") return { state: "pending" };
      return { state: "failed", message: errorMessage(body, r.error) };
    }
    if (typeof r.data?.apiKey !== "string") return { state: "failed", message: "The account is ready but no key came back." };
    return { state: "key", apiKey: r.data.apiKey };
  },
  async keyRefused(key) {
    return (await callApi("/v1/me", { apiKey: key })).status === 401;
  },
};

/** What an /authorize request asked for, checked. */
export interface AuthorizeRequest {
  clientId: string;
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
}

/**
 * Checks an authorization request. `redirect` = the error can go back to the
 * client (RFC 6749 4.1.2.1); `page` = it cannot (unknown client or redirect),
 * so the person sees it.
 */
export function parseAuthorizeRequest(q: Record<string, unknown>):
  | { ok: true; req: AuthorizeRequest }
  | { ok: false; kind: "page"; message: string }
  | { ok: false; kind: "redirect"; redirectUri: string; state: string | null; error: string; description: string } {
  const client = decodeClientId(q.client_id);
  if (!client) return { ok: false, kind: "page", message: "This app is not registered with distribute.you. Add the connector again from your app." };
  const redirectUri = typeof q.redirect_uri === "string" ? q.redirect_uri : client.redirectUris.length === 1 ? client.redirectUris[0] : null;
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, kind: "page", message: "This app asked to come back to an address it did not register. Add the connector again from your app." };
  }
  const state = typeof q.state === "string" ? q.state : null;
  if (q.response_type !== "code") {
    return { ok: false, kind: "redirect", redirectUri, state, error: "unsupported_response_type", description: "Only response_type=code is supported." };
  }
  if (typeof q.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge) || q.code_challenge_method !== "S256") {
    return { ok: false, kind: "redirect", redirectUri, state, error: "invalid_request", description: "PKCE with code_challenge_method=S256 is required." };
  }
  return { ok: true, req: { clientId: q.client_id as string, client, redirectUri, codeChallenge: q.code_challenge, state } };
}

export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

interface Pending {
  req: AuthorizeRequest;
  email: string;
  pollToken: string;
  expiresAt: number;
  /** The redirect, once the person approved. */
  done?: string;
  failed?: string;
  polling?: Promise<void>;
}

interface IssuedCode {
  apiKey: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

function newId(): string {
  return randomBytes(32).toString("base64url");
}

/** A key name the person recognises in their key list, to revoke this one app. */
export function keyNameFor(client: OAuthClient, now = new Date()): string {
  return `${client.name} connector ${now.toISOString().slice(0, 10)}`;
}

// ── Pages ───────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const BUTTON =
  "background:#1a1a1a;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;font-weight:600;cursor:pointer;";

function page(title: string, body: string, script = ""): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;color:#1a1a1a;">',
    `<h1 style="font-size:22px;">${escapeHtml(title)}</h1>`,
    body,
    '<p style="font-size:13px;color:#8b8e98;margin-top:40px;">distribute.you. Revenue made easy.</p>',
    script,
    "</body></html>",
  ].join("");
}

const P = (html: string) => `<p style="font-size:16px;line-height:1.6;">${html}</p>`;

export function emailPage(r: AuthorizeRequest, error?: string): string {
  const app = escapeHtml(r.client.name);
  const hidden = (name: string, value: string | null) =>
    value === null ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return page(
    `Connect ${r.client.name} to distribute.you`,
    P(`${app} will work on your distribute.you account in every chat, until you remove it.`) +
      (error ? `<p style="font-size:15px;color:#b42318;">${escapeHtml(error)}</p>` : "") +
      '<form method="post" action="/authorize">' +
      hidden("client_id", r.clientId) +
      hidden("redirect_uri", r.redirectUri) +
      hidden("code_challenge", r.codeChallenge) +
      hidden("code_challenge_method", "S256") +
      hidden("response_type", "code") +
      hidden("state", r.state) +
      '<label for="email" style="display:block;font-size:15px;font-weight:600;margin:16px 0 8px;">Your email</label>' +
      '<input id="email" name="email" type="email" required autocomplete="email" autofocus style="width:100%;box-sizing:border-box;font-size:16px;padding:12px;border:1px solid #d0d5dd;border-radius:8px;margin-bottom:16px;">' +
      `<button type="submit" style="${BUTTON}">Continue</button></form>` +
      P(`<span style="font-size:14px;color:#475467;">New to distribute.you? This email opens your account. You then go back to <strong>${escapeHtml(new URL(r.redirectUri).host)}</strong>.</span>`),
  );
}

export function inboxPage(email: string, pendingId: string): string {
  const script =
    "<script>(function(){var id=" +
    JSON.stringify(pendingId) +
    ";function tick(){fetch('/authorize/status?id='+encodeURIComponent(id),{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){" +
    "if(s.redirect){document.getElementById('st').textContent='Approved. Taking you back.';window.location.replace(s.redirect);return}" +
    "if(s.error){document.getElementById('st').textContent=s.error;return}setTimeout(tick,3000)}).catch(function(){setTimeout(tick,5000)})}setTimeout(tick,2000)})();</script>";
  return page(
    "Check your inbox",
    P(`We sent an email to <strong>${escapeHtml(email)}</strong>.`) +
      P("Click <strong>Confirm</strong> in it. This page moves on by itself.") +
      `<p id="st" style="font-size:14px;color:#475467;">Waiting for your click.</p>`,
    script,
  );
}

export function errorPage(message: string): string {
  return page("This link does not work", P(escapeHtml(message)));
}

// ── Router ──────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createOAuthRouter(api: SignupApi = gatewaySignupApi, now: () => number = Date.now): Router {
  const router = Router();
  const pending = new Map<string, Pending>();
  const codes = new Map<string, IssuedCode>();

  function sweep() {
    const t = now();
    for (const [k, p] of pending) if (p.expiresAt <= t) pending.delete(k);
    for (const [k, c] of codes) if (c.expiresAt <= t) codes.delete(k);
  }

  const form = express.urlencoded({ extended: false });

  router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    res.json(protectedResourceMetadata(publicOrigin(req)));
  });
  router.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], (req, res) => {
    res.json(authorizationServerMetadata(publicOrigin(req)));
  });

  router.post("/register", (req, res) => {
    const r = registerClient(req.body);
    if (!r.ok) return res.status(400).json({ error: r.error, error_description: r.error_description });
    res.status(201).json(r.response);
  });

  function answerAuthorize(q: Record<string, unknown>, res: Response): AuthorizeRequest | null {
    const parsed = parseAuthorizeRequest(q);
    if (parsed.ok) return parsed.req;
    res.set("cache-control", "no-store");
    if (parsed.kind === "page") {
      res.status(400).type("html").send(errorPage(parsed.message));
    } else {
      res.redirect(302, redirectWith(parsed.redirectUri, { error: parsed.error, error_description: parsed.description, state: parsed.state }));
    }
    return null;
  }

  router.get("/authorize", (req, res) => {
    const r = answerAuthorize(req.query as Record<string, unknown>, res);
    if (!r) return;
    res.set("cache-control", "no-store").type("html").send(emailPage(r));
  });

  router.post("/authorize", form, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = answerAuthorize(body, res);
    if (!r) return;
    res.set("cache-control", "no-store");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) return res.status(400).type("html").send(emailPage(r, "Please type a valid email."));
    const started = await api.start(email);
    if (!started.ok) return res.status(502).type("html").send(emailPage(r, `We could not send the email: ${started.message}`));
    sweep();
    const id = newId();
    pending.set(id, { req: r, email, pollToken: started.pollToken, expiresAt: now() + PENDING_TTL_MS });
    res.type("html").send(inboxPage(email, id));
  });

  /** The inbox page polls here. One gateway poll at a time per approval, so the key is minted once. */
  router.get("/authorize/status", async (req, res) => {
    res.set("cache-control", "no-store");
    const id = typeof req.query.id === "string" ? req.query.id : "";
    const p = pending.get(id);
    if (!p || p.expiresAt <= now()) {
      return res.status(404).json({ error: "This page expired. Go back to your app and click Connect again." });
    }
    if (!p.done && !p.failed) {
      p.polling ??= (async () => {
        const out = await api.complete(p.email, p.pollToken, keyNameFor(p.req.client));
        if (out.state === "key") {
          const code = newId();
          codes.set(code, {
            apiKey: out.apiKey,
            clientId: p.req.clientId,
            redirectUri: p.req.redirectUri,
            codeChallenge: p.req.codeChallenge,
            expiresAt: now() + CODE_TTL_MS,
          });
          p.done = redirectWith(p.req.redirectUri, { code, state: p.req.state });
        } else if (out.state === "failed") {
          p.failed = `${out.message} Go back to your app and click Connect again.`;
        }
      })().finally(() => {
        p.polling = undefined;
      });
      await p.polling;
    }
    if (p.done) {
      // Handed to the browser once: a replay of this id finds nothing.
      pending.delete(id);
      return res.json({ redirect: p.done });
    }
    if (p.failed) return res.json({ error: p.failed });
    res.json({ pending: true });
  });

  router.post("/token", form, async (req, res) => {
    res.set("cache-control", "no-store").set("pragma", "no-cache");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fail = (status: number, error: string, description: string) =>
      res.status(status).json({ error, error_description: description });

    if (b.grant_type === "authorization_code") {
      sweep();
      const code = typeof b.code === "string" ? b.code : "";
      const issued = codes.get(code);
      // Single use: gone whether this redemption succeeds or not (OAuth 2.1 4.1.3).
      codes.delete(code);
      if (!issued || issued.expiresAt <= now()) return fail(400, "invalid_grant", "This code is unknown, used or expired.");
      if (b.client_id !== undefined && b.client_id !== issued.clientId) return fail(400, "invalid_grant", "This code was issued to another client.");
      if (b.redirect_uri !== undefined && b.redirect_uri !== issued.redirectUri) return fail(400, "invalid_grant", "redirect_uri does not match.");
      if (!pkceMatches(b.code_verifier, issued.codeChallenge)) return fail(400, "invalid_grant", "code_verifier does not match.");
      return res.json({ access_token: issued.apiKey, token_type: "Bearer", refresh_token: issued.apiKey, scope: "distribute" });
    }

    if (b.grant_type === "refresh_token") {
      // The token is the person's API key and never expires: a refresh hands it back while it is live.
      const key = typeof b.refresh_token === "string" ? b.refresh_token : "";
      if (!key || (await api.keyRefused(key))) return fail(400, "invalid_grant", "This key was revoked. Connect again.");
      return res.json({ access_token: key, token_type: "Bearer", refresh_token: key, scope: "distribute" });
    }

    return fail(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  });

  return router;
}
