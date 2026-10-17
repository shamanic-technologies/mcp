/**
 * Client for the distribute.you API gateway.
 *
 * The key travels as `Authorization: Bearer <key>`, which is what api-service
 * validates a customer key with. It used to go out under the gateway's
 * admin-key header instead — a SEPARATE auth path reserved for the platform
 * key, which answers a customer key with `401 Invalid admin key`. Every tool in
 * this server failed on its first call because of it, so do not reintroduce
 * that header: the key this server receives is already a Bearer, and stays one.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const API_BASE_URL = process.env.DISTRIBUTE_API_URL || "https://api.distribute.you";

/**
 * Headers this server adds to EVERY gateway call, so the gateway tells MCP
 * traffic from a direct API call. api-service (v0.112.95, `src/lib/call-log.ts`)
 * files every user-key call on that person's staff Unibox thread, under channel
 * `mcp` when `x-distribute-client: mcp` is present, named by the tool in
 * `x-distribute-mcp-tool` (MCP_TOOL_HEADER, set per call from the call's context).
 * This is the single place the marker lives.
 */
export const MCP_CLIENT_HEADERS: Record<string, string> = { "x-distribute-client": "mcp" };

/** Names the MCP tool a gateway call serves (api-service keeps the first 200 chars). */
export const MCP_TOOL_HEADER = "x-distribute-mcp-tool";

/**
 * The gateway's refusal body, kept whole. A multi-org key that names no target
 * gets `400 org_target_required` with `code`, `message`, `fix` and the
 * `organizations` it can choose from; reducing that to `error` alone threw away
 * the only part that tells the caller what to do next.
 */
export interface ApiErrorBody {
  error?: string;
  code?: string;
  message?: string;
  fix?: string;
  organizations?: unknown;
  [key: string]: unknown;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  errorBody?: ApiErrorBody;
  status?: number;
}

/**
 * The key of the call being served. One server process serves every session at
 * once, so the key is bound to the async context of the tool call it belongs to.
 * It used to be one module-level variable, set before each call: two sessions
 * calling at the same time could then send one customer's request under another
 * customer's key as soon as a tool awaited between two gateway calls.
 */
const callContext = new AsyncLocalStorage<{ key: string | null; tool: string | null }>();

/**
 * Run `fn` with `key` as the key every gateway call inside it is made with, and
 * `tool` as the MCP tool those calls are made for (sent as MCP_TOOL_HEADER).
 */
export function runWithApiKey<T>(key: string | null, fn: () => Promise<T>, tool: string | null = null): Promise<T> {
  return callContext.run({ key, tool }, fn);
}

export function getApiKey(): string | null {
  return callContext.getStore()?.key ?? null;
}

/**
 * What a tool called with no key says. An agent with no key can get one itself,
 * no human needed, so the refusal names the two tools that do it.
 */
export const NO_KEY_MESSAGE = "This session has no distribute.you API key.";
export const NO_KEY_FIX =
  "No human needed: call distribute_signup_start with an email and a phone, then distribute_signup_complete with the code emailed. " +
  "It returns an API key and this session uses it right away. An existing key goes in the header `Authorization: Bearer <key>`.";

/** Header values are ASCII, one line, at most 200 chars (what the gateway keeps). */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?").slice(0, 200);
}

/**
 * The ETag the gateway serves for `path`, read with HEAD (no body crosses the
 * wire). Same key and MCP headers as callApi. `etag` is null when the gateway
 * sends none; `error` is set when the check itself failed.
 */
export async function headApi(
  path: string,
  options: { apiKey?: string | null; mcpTool?: string } = {},
): Promise<{ status: number | null; etag: string | null; error?: string }> {
  const tool = options.mcpTool ?? callContext.getStore()?.tool ?? null;
  const key = options.apiKey === undefined ? getApiKey() : options.apiKey;
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "HEAD",
      headers: {
        ...MCP_CLIENT_HEADERS,
        ...(tool ? { [MCP_TOOL_HEADER]: headerSafe(tool) } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });
    return { status: response.status, etag: response.ok ? response.headers.get("etag") : null, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
  } catch (err) {
    return { status: null, etag: null, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * A transport failure's own words ("fetch failed", "other side closed",
 * "ECONNREFUSED ...") say nothing an agent can act on. The gateway forwards them
 * as-is when the service behind a route did not answer: 2026-10-14, GET
 * /v1/offers/{offerId}/sales-funnels answered `500 {"error":"fetch failed"}`
 * while features-service was being redeployed, and the agent read it as a broken
 * route. Matched only on a body carrying no `fix` of its own.
 */
const TRANSPORT_FAILURE = /^(fetch failed|other side closed|socket hang up|terminated|network error)\b|\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_[A-Z_]+)\b/i;

export const UNREACHABLE_CODE = "upstream_unreachable";
export const UNREACHABLE_MESSAGE =
  "The distribute.you service behind this route did not answer: the connection dropped before any reply. " +
  "This is not a refusal of the request: the service is usually restarting for a deploy, which takes under a minute.";
export const UNREACHABLE_FIX =
  "Retry the same call in about 30 seconds. If it still fails after 2 or 3 tries, narrow the read (a filter such as `q`, or `limit`) and tell the user the service is down.";

function isTransportFailure(body: ApiErrorBody | null | undefined): boolean {
  if (!body || body.fix) return false;
  const words = [body.error, body.message].filter((v): v is string => typeof v === "string");
  return words.some((w) => TRANSPORT_FAILURE.test(w.trim()));
}

/** The transport failure, named: what happened, raw words kept as `cause`, and what to do. */
function unreachable(cause: string): ApiErrorBody {
  return { error: UNREACHABLE_CODE, code: UNREACHABLE_CODE, message: UNREACHABLE_MESSAGE, fix: UNREACHABLE_FIX, cause };
}

/** "fetch failed (ECONNREFUSED)": undici hides the real reason in `cause`. */
function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return "Network error";
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : null;
  return detail ? `${err.message} (${detail})` : err.message;
}

export async function callApi<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    apiKey?: string;
    /** Overrides the call context's tool name, e.g. to add the operation a generic call runs. */
    mcpTool?: string;
    /**
     * A public gateway route (agent signup) is called with NO key, even when the
     * session has one: the route takes none, and a key sent to it would only
     * tie an anonymous signup to whoever's session it ran in.
     */
    public?: boolean;
  } = {}
): Promise<ApiResponse<T>> {
  const { method = "GET", body, apiKey } = options;
  const tool = options.mcpTool ?? callContext.getStore()?.tool ?? null;
  const key = options.public ? null : apiKey || getApiKey();

  if (!key && !options.public) {
    return {
      error: NO_KEY_MESSAGE,
      errorBody: { error: "api_key_required", code: "api_key_required", message: NO_KEY_MESSAGE, fix: NO_KEY_FIX },
      status: 401,
    };
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...MCP_CLIENT_HEADERS,
        ...(tool ? { [MCP_TOOL_HEADER]: headerSafe(tool) } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // A 5xx answered with an HTML page is the edge's own error page (Cloudflare "502: Bad gateway"),
      // not an answer from the service: 2026-10-17 an agent got 3 KB of HTML for a correction while
      // the service behind it timed out. Named like any other transport failure.
      if (response.status >= 500 && /^\s*<(!doctype|html)/i.test(text)) {
        const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
        return { error: UNREACHABLE_CODE, errorBody: unreachable(`HTTP ${response.status} edge error page${title ? `: ${title}` : ""}`), status: response.status };
      }
      let errorBody: ApiErrorBody | null = null;
      try {
        errorBody = text ? (JSON.parse(text) as ApiErrorBody) : null;
      } catch {
        errorBody = text ? { error: text.slice(0, 2000) } : null;
      }
      if (response.status >= 500 && isTransportFailure(errorBody)) {
        const cause = String(errorBody?.error ?? errorBody?.message);
        return { error: UNREACHABLE_CODE, errorBody: unreachable(cause), status: response.status };
      }
      return {
        error: (typeof errorBody?.error === "string" && errorBody.error) || `HTTP ${response.status}`,
        errorBody: errorBody ?? undefined,
        status: response.status,
      };
    }

    // A 204 (or any empty success) has no JSON to read.
    // A non-JSON success (a CSV export, plain text) is handed back as text.
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { data: data as T, status: response.status };
  } catch (err) {
    // The gateway itself did not answer: same situation, one hop earlier.
    return { error: UNREACHABLE_CODE, errorBody: unreachable(describeNetworkError(err)) };
  }
}

export function isConfigured(): boolean {
  return !!getApiKey();
}

export function getConfigStatus(): { configured: boolean; apiUrl: string } {
  return {
    configured: !!getApiKey(),
    apiUrl: API_BASE_URL,
  };
}
