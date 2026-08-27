import type { Request } from "express";
import { toolDefinitions } from "./tools/index.js";

/**
 * The MCP specification defines two transports (stdio and Streamable HTTP) and
 * says nothing about how an agent DISCOVERS a server it has only the hostname
 * for. So this document is a de-facto convention, not a standard: it exists so
 * that an agent arriving at this host can learn what the server is, how to
 * reach it, and how to authenticate, without a human reading prose in the docs.
 *
 * It is built from the SAME `toolDefinitions` the server registers on every
 * session, so the advertised tool list cannot drift from the tools that are
 * actually callable. Adding a tool updates this document for free.
 */
export interface McpDiscoveryDocument {
  name: string;
  version: string;
  description: string;
  transport: "streamable-http";
  endpoint: string;
  authentication: {
    type: "bearer";
    description: string;
  };
  documentation: string;
  openapi: string;
  tools: { name: string; description: string }[];
}

export const SERVER_NAME = "distribute.you";
/** Single source for the version this server reports, so the MCP handshake and
 * the discovery document can never advertise two different versions. */
export const SERVER_VERSION = "0.1.0";
export const DOCS_URL = "https://docs.distribute.you/";
export const OPENAPI_URL = "https://api.distribute.you/openapi.json";

/**
 * The public origin this server answers on. Derived from the request rather
 * than from configuration: the process binds to 0.0.0.0 inside a container, so
 * its own address is not the address a caller typed, and a hardcoded origin
 * would be wrong the moment the host changes. `x-forwarded-proto` is set by the
 * edge in front of us; a direct request that carries none is plain HTTP.
 */
export function publicOrigin(req: Request): string {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto =
    typeof forwardedProto === "string" ? forwardedProto.split(",")[0].trim() : req.protocol;
  const host = req.headers.host;
  if (!host) {
    throw new Error("Cannot resolve the public origin: request carries no Host header");
  }
  return `${proto}://${host}`;
}

export function discoveryDocument(req: Request): McpDiscoveryDocument {
  const origin = publicOrigin(req);
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description:
      "Run cold email acquisition for a brand: list brands and campaigns, read campaign " +
      "performance, inspect the workflows behind a campaign, and draft an ideal customer " +
      "profile from a website. Every call is scoped to the organisation that owns the " +
      "Bearer key it is made with.",
    transport: "streamable-http",
    endpoint: `${origin}/mcp`,
    authentication: {
      type: "bearer",
      description:
        "Send an API key created in the distribute.you dashboard as `Authorization: Bearer " +
        "<key>`. The key carries organisation and user identity; no other header is needed.",
    },
    documentation: DOCS_URL,
    openapi: OPENAPI_URL,
    tools: Object.entries(toolDefinitions).map(([name, def]) => ({
      name,
      description: def.description,
    })),
  };
}

/**
 * What an agent (or a person) gets for a path this server does not serve. A real
 * 404 with a body naming where to look next beats a 404 with an empty body: the
 * caller can recover without guessing, and an agent can parse it.
 */
export function notFoundDocument(req: Request): Record<string, unknown> {
  const origin = publicOrigin(req);
  return {
    error: "Not found",
    message: `${req.method} ${req.path} is not served by this MCP server.`,
    endpoints: {
      mcp: `${origin}/mcp`,
      discovery: `${origin}/.well-known/mcp.json`,
      openapi: `${origin}/openapi.json`,
      health: `${origin}/health`,
    },
    documentation: DOCS_URL,
  };
}
