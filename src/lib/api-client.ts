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

const API_BASE_URL = process.env.DISTRIBUTE_API_URL || "https://api.distribute.you";

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

// Store the current API key (set from request context)
let currentApiKey: string | null = null;

export function setApiKey(key: string | null): void {
  currentApiKey = key;
}

export function getApiKey(): string | null {
  return currentApiKey;
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
  const key = apiKey || currentApiKey;

  if (!key) {
    return { error: "API key not provided. Include your API key in the Authorization header." };
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: "Request failed" })) as { error?: string };
      return { error: errorBody.error || `HTTP ${response.status}` };
    }

    const data = await response.json() as T;
    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Network error" };
  }
}

export function isConfigured(): boolean {
  return !!currentApiKey;
}

export function getConfigStatus(): { configured: boolean; apiUrl: string } {
  return {
    configured: !!currentApiKey,
    apiUrl: API_BASE_URL,
  };
}
