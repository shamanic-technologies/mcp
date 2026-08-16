import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callApi, setApiKey, getConfigStatus } from "../src/lib/api-client.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  setApiKey(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("callApi", () => {
  it("sends the org key as a Bearer token — api-service rejects it as X-API-Key", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    setApiKey("distrib.usr_abc123");
    await callApi("/v1/me");

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe("https://api.distribute.you/v1/me");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer distrib.usr_abc123");
    expect(headers["X-API-Key"]).toBeUndefined();
  });

  it("refuses to call without a key", async () => {
    const result = await callApi("/v1/me");
    expect(result.error).toBeDefined();
  });

  it("defaults to the deployed distribute gateway", () => {
    expect(getConfigStatus().apiUrl).toBe("https://api.distribute.you");
  });
});
