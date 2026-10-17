import { describe, it, expect, vi, afterEach } from "vitest";
import { callApi, runWithApiKey, UNREACHABLE_CODE } from "../src/lib/api-client.js";

/**
 * 2026-10-14: GET /v1/offers/{offerId}/sales-funnels through distribute_call_api
 * answered `{"status":500,"error":"fetch failed"}` twice, while features-service was
 * being redeployed. The gateway forwards the transport's own words; the agent read
 * them as a broken route and dead-ended. A transport failure is now named, with
 * what to do.
 */
const PATH = "/v1/offers/d5ecba00-783a-4939-b5bd-f85b9e6b7d9e/sales-funnels?brandId=75d7e3e8-6926-4f85-a557-976895400666";

afterEach(() => vi.restoreAllMocks());

describe("a route whose service did not answer", () => {
  it("names the gateway's bare 500 `fetch failed` and says what to do", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "fetch failed" }), { status: 500 }));
    const res = await runWithApiKey("k", () => callApi(PATH));
    expect(res.status).toBe(500);
    expect(res.error).toBe(UNREACHABLE_CODE);
    expect(res.errorBody).toMatchObject({ code: UNREACHABLE_CODE, cause: "fetch failed" });
    expect(res.errorBody?.message).toMatch(/did not answer/);
    expect(res.errorBody?.fix).toMatch(/Retry the same call/);
  });

  it("names a 502 carrying a socket error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "connect ECONNREFUSED 172.18.0.12:8080" }), { status: 502 }),
    );
    const res = await runWithApiKey("k", () => callApi(PATH));
    expect(res.errorBody).toMatchObject({ code: UNREACHABLE_CODE, cause: "connect ECONNREFUSED 172.18.0.12:8080" });
  });

  it("names a failure to reach the gateway itself, with undici's hidden cause", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }),
    );
    const res = await runWithApiKey("k", () => callApi(PATH));
    expect(res.error).toBe(UNREACHABLE_CODE);
    expect(res.errorBody).toMatchObject({ code: UNREACHABLE_CODE, cause: "fetch failed (ECONNREFUSED)" });
    expect(res.errorBody?.fix).toMatch(/30 seconds/);
  });

  it("names the edge's HTML 502 page instead of handing back 3 KB of HTML", async () => {
    const html = "<!DOCTYPE html>\n<html><head><title>distribute.you | 502: Bad gateway</title></head><body>cf</body></html>";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(html, { status: 502 }));
    const res = await runWithApiKey("k", () => callApi(PATH));
    expect(res.error).toBe(UNREACHABLE_CODE);
    expect(res.errorBody).toMatchObject({ code: UNREACHABLE_CODE, cause: "HTTP 502 edge error page: distribute.you | 502: Bad gateway" });
    expect(JSON.stringify(res.errorBody)).not.toContain("<html");
  });

  it("leaves a service's own 500 words alone", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Offer has no stated value" }), { status: 500 }));
    const res = await runWithApiKey("k", () => callApi(PATH));
    expect(res.error).toBe("Offer has no stated value");
    expect(res.errorBody).toEqual({ error: "Offer has no stated value" });
  });

  it("leaves a refusal that already says what to do alone", async () => {
    const body = { error: "fetch failed", fix: "Pass `q`." };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 503 }));
    const res = await runWithApiKey("k", () => callApi(PATH));
    expect(res.errorBody).toEqual(body);
  });

  it("leaves a 4xx alone even when its words look like a transport failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "fetch failed" }), { status: 400 }));
    const res = await runWithApiKey("k", () => callApi(PATH));
    expect(res.error).toBe("fetch failed");
  });
});
