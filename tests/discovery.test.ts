import { describe, it, expect, vi } from "vitest";
import type { Request } from "express";

vi.mock("../src/lib/api-client.js", () => ({
  getConfigStatus: vi.fn(() => ({ configured: true, apiUrl: "https://api.distribute.you" })),
  callApi: vi.fn(),
  setApiKey: vi.fn(),
  getApiKey: vi.fn(() => "test-key"),
  isConfigured: vi.fn(() => true),
}));

import {
  discoveryDocument,
  notFoundDocument,
  publicOrigin,
  SERVER_NAME,
  SERVER_VERSION,
} from "../src/discovery.js";
import { toolDefinitions } from "../src/tools/index.js";

function req(headers: Record<string, string | undefined>, extra: Partial<Request> = {}): Request {
  return { headers, protocol: "http", method: "GET", path: "/", ...extra } as unknown as Request;
}

describe("publicOrigin", () => {
  it("uses the host the caller actually typed, not the address we bind to", () => {
    expect(publicOrigin(req({ host: "mcp.distribute.you", "x-forwarded-proto": "https" }))).toBe(
      "https://mcp.distribute.you",
    );
  });

  it("reads the first value when an edge appends to x-forwarded-proto", () => {
    expect(publicOrigin(req({ host: "mcp.distribute.you", "x-forwarded-proto": "https, http" }))).toBe(
      "https://mcp.distribute.you",
    );
  });

  it("falls through to the request protocol when no edge set one", () => {
    expect(publicOrigin(req({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });

  // Fail loud: a request with no Host cannot be answered with a guessed origin,
  // because every URL in the document would then point somewhere unreachable.
  it("throws rather than inventing an origin when the Host header is absent", () => {
    expect(() => publicOrigin(req({}))).toThrow(/Host header/);
  });
});

describe("discoveryDocument", () => {
  const doc = discoveryDocument(req({ host: "mcp.distribute.you", "x-forwarded-proto": "https" }));

  it("names the server, its version and its transport", () => {
    expect(doc.name).toBe(SERVER_NAME);
    expect(doc.version).toBe(SERVER_VERSION);
    expect(doc.transport).toBe("streamable-http");
  });

  it("points at the endpoint that actually serves MCP on this host", () => {
    expect(doc.endpoint).toBe("https://mcp.distribute.you/mcp");
  });

  it("states how to authenticate", () => {
    expect(doc.authentication.type).toBe("bearer");
    expect(doc.authentication.description).toMatch(/Authorization/);
  });

  // The advertised tools are built from the same definitions the server registers
  // per session, so a manifest can never advertise a tool that is not callable.
  it("advertises exactly the tools the server registers", () => {
    expect(doc.tools.map((t) => t.name).sort()).toEqual(Object.keys(toolDefinitions).sort());
    expect(doc.tools.every((t) => t.description.length > 0)).toBe(true);
  });

  it("links the human docs and the public OpenAPI document", () => {
    expect(doc.documentation).toBe("https://docs.distribute.you/");
    expect(doc.openapi).toBe("https://api.distribute.you/openapi.json");
  });
});

describe("notFoundDocument", () => {
  const body = notFoundDocument(
    req({ host: "mcp.distribute.you", "x-forwarded-proto": "https" }, {
      method: "GET",
      path: "/does-not-exist",
    }),
  );

  it("says what was not found", () => {
    expect(body.message).toBe("GET /does-not-exist is not served by this MCP server.");
  });

  // A 404 that names nowhere to go leaves a caller guessing; these four are every
  // path this server actually serves.
  it("names every endpoint this server does serve", () => {
    expect(body.endpoints).toEqual({
      mcp: "https://mcp.distribute.you/mcp",
      discovery: "https://mcp.distribute.you/.well-known/mcp.json",
      openapi: "https://mcp.distribute.you/openapi.json",
      health: "https://mcp.distribute.you/health",
    });
  });
});
