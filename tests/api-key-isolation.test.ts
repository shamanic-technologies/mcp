import { describe, it, expect, vi } from "vitest";
import { callApi, runWithApiKey, MCP_CLIENT_HEADERS } from "../src/lib/api-client.js";

/**
 * One process serves every session. The key used to be a module-level variable
 * set before each tool call, so two sessions calling at once could send one
 * customer's request under another customer's key as soon as a tool awaited.
 */
describe("each call goes out under its own session's key", () => {
  it("keeps two concurrent sessions' keys apart across awaits", async () => {
    const seen: Array<[string, string]> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      seen.push([String(url).split("?")[0]!.replace(/.*\/v1/, "/v1"), auth]);
      await new Promise((r) => setTimeout(r, 5));
      return new Response("{}", { status: 200 });
    });
    const tool = async (tag: string) => {
      await callApi(`/v1/${tag}/one`);
      await new Promise((r) => setTimeout(r, 1));
      await callApi(`/v1/${tag}/two`);
    };
    await Promise.all([runWithApiKey("key-A", () => tool("a")), runWithApiKey("key-B", () => tool("b"))]);
    for (const [path, auth] of seen) {
      expect(auth).toBe(path.startsWith("/v1/a/") ? "Bearer key-A" : "Bearer key-B");
    }
    expect(seen).toHaveLength(4);
    fetchSpy.mockRestore();
  });

  it("sends nothing when the call carries no key", async () => {
    const res = await runWithApiKey(null, () => callApi("/v1/me"));
    expect(res.error).toMatch(/no distribute.you API key/);
    expect(res.errorBody?.fix).toMatch(/distribute_signup_start/);
  });

  it("calls a public route (agent signup) with no key, even from a keyed session", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await runWithApiKey(null, () => callApi("/v1/agent-signups/start", { method: "POST", body: {}, public: true }));
    await runWithApiKey("key-A", () => callApi("/v1/agent-signups/complete", { method: "POST", body: {}, public: true }));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      expect((call[1]!.headers as Record<string, string>).Authorization).toBeUndefined();
    }
    fetchSpy.mockRestore();
  });

  it("marks every gateway call as MCP traffic, named by the tool it serves", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await runWithApiKey("k", () => callApi("/v1/me"), "distribute_status");
    await runWithApiKey("k", () => callApi("/v1/leads", { mcpTool: "distribute_call_api GET /v1/leads" }), "distribute_call_api");
    await runWithApiKey("k", () => callApi("/v1/me"));
    const headers = fetchSpy.mock.calls.map((c) => c[1]!.headers as Record<string, string>);
    expect(headers[0]).toMatchObject({ "x-distribute-client": "mcp", "x-distribute-mcp-tool": "distribute_status", Authorization: "Bearer k" });
    expect(headers[1]!["x-distribute-mcp-tool"]).toBe("distribute_call_api GET /v1/leads");
    expect(headers[2]!["x-distribute-client"]).toBe("mcp");
    expect(headers[2]).not.toHaveProperty("x-distribute-mcp-tool");
    fetchSpy.mockRestore();
  });

  it("adds the MCP traffic marker headers from one single place", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    MCP_CLIENT_HEADERS["x-test-marker"] = "1";
    await runWithApiKey("k", () => callApi("/v1/me"));
    expect((fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>)["x-test-marker"]).toBe("1");
    delete MCP_CLIENT_HEADERS["x-test-marker"];
    fetchSpy.mockRestore();
  });
});
