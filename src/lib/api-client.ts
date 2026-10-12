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
 * Headers this server adds to EVERY gateway call, so the gateway can tell MCP
 * traffic from a direct API call (e.g. to record each MCP call as a conversation).
 * This is the single place such a marker goes: no api-service release names one
 * yet, so it is empty. When the gateway ships its marker, add it here and nowhere else.
 */
export const MCP_CLIENT_HEADERS: Record<string, string> = {};

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
const keyContext = new AsyncLocalStorage<string | null>();

/** Run `fn` with `key` as the key every gateway call inside it is made with. */
export function runWithApiKey<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  return keyContext.run(key, fn);
}

export function getApiKey(): string | null {
  return keyContext.getStore() ?? null;
}

export async function callApi<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    apiKey?: string;
  } = {}
): Promise<ApiResponse<T>> {
  const { method = "GET", body, apiKey } = options;
  const key = apiKey || getApiKey();

  if (!key) {
    return { error: "API key not provided. Include your API key in the Authorization header." };
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...MCP_CLIENT_HEADERS,
        Authorization: `Bearer ${key}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let errorBody: ApiErrorBody | null = null;
      try {
        errorBody = text ? (JSON.parse(text) as ApiErrorBody) : null;
      } catch {
        errorBody = text ? { error: text.slice(0, 2000) } : null;
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
    return { error: err instanceof Error ? err.message : "Network error" };
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
