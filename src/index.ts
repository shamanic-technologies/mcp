// IMPORTANT: Import instrument first to initialize Sentry before anything else
import "./instrument.js";
import * as Sentry from "@sentry/node";
import express, { Request, Response, Express } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toolDefinitions, handleToolCall, mintedKey, planWall } from "./tools/index.js";
import { runWithApiKey, callApi } from "./lib/api-client.js";
import { SessionKey, newSessionKey, applyHeaderKey, noteKeyRefused, adoptMintedKey } from "./lib/session-key.js";
import { discoveryDocument, notFoundDocument, publicOrigin, SERVER_NAME, SERVER_VERSION } from "./discovery.js";
import { createOAuthRouter, gatewaySignupApi, wwwAuthenticate } from "./oauth.js";

const PORT = process.env.PORT || 3000;

// Create Express app
const app: Express = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
  exposedHeaders: ["mcp-session-id", "WWW-Authenticate"],
}));

app.use(express.json());

// OAuth front door (MCP-OAUTH-1125): claude.ai / ChatGPT connectors approve once
// through the agent-signup email link and hold the person's own API key.
app.use(createOAuthRouter());

// Session data includes transport and API key
interface SessionData extends SessionKey {
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionData>();

// Extract API key from Authorization: Bearer <key> header
function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return null;
}

// OpenAPI spec endpoint
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

// Discovery document. An agent that knows only this hostname can read what this
// server is, which transport it speaks, where its endpoint is, and how to
// authenticate — with no human-readable prose in the loop. No MCP specification
// defines a well-known URI for this; the path below is a de-facto convention.
app.get("/.well-known/mcp.json", (req, res) => {
  res.json(discoveryDocument(req));
});

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    res.json(spec);
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated yet. Run: pnpm generate:openapi" });
  }
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "mcp-service" });
});

// MCP endpoint - POST for JSON-RPC requests
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    // Extract API key from request
    const apiKey = extractApiKey(req);
    
    // Get or create session
    let sessionId = req.headers["mcp-session-id"] as string | undefined;
    let sessionData = sessionId ? sessions.get(sessionId) : undefined;

    if (!sessionData) {
      // A new session needs a key. Without one (claude.ai, ChatGPT, Claude Code
      // with no header), the 401 starts the client's OAuth flow; a revoked key
      // gets the same answer, so the app asks the person to connect again.
      const challenge = !apiKey
        ? wwwAuthenticate(publicOrigin(req))
        : (await gatewaySignupApi.keyRefused(apiKey))
          ? wwwAuthenticate(publicOrigin(req), "invalid_token")
          : null;
      if (challenge) {
        res.setHeader("WWW-Authenticate", challenge);
        return res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: apiKey
              ? "This API key was revoked or is not valid. Connect again: your app opens the distribute.you approval page."
              : "Connect your distribute.you account: your app opens the approval page (OAuth). A header-capable client can send Authorization: Bearer <API key> instead.",
          },
          id: null,
        });
      }

      // Create new session
      sessionId = crypto.randomUUID();
      
      // Create MCP server for this session
      const mcpServer = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });

      // Register tools - each tool will use the session's API key
      for (const [name, def] of Object.entries(toolDefinitions)) {
        mcpServer.tool(
          name,
          def.description,
          def.schema.shape,
          async (args: Record<string, unknown>) => {
            // The call runs under THIS session's key, bound to its own async
            // context: concurrent sessions never see each other's key.
            const session = sessions.get(sessionId!);
            const result = await runWithApiKey(
              session?.apiKey ?? null,
              // An account on the solo plan that is out of credit gets the fixed notice first (SOLO-PLAN-1125).
              async () => (await planWall(name, args)) ?? handleToolCall(name, args),
              name,
              (key) => session && noteKeyRefused(session, key),
            );
            // An agent that signed up through this session keeps working in it:
            // a session with no key, or with a key the gateway refuses, adopts the
            // key it just minted. A session whose key works keeps it.
            const minted = mintedKey(name, result);
            if (minted && session) {
              await adoptMintedKey(session, minted, async (key) => (await callApi("/v1/me", { apiKey: key })).status === 401);
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }
        );
      }

      // Create transport
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId!,
        onsessioninitialized: (id) => {
          // Update session with transport once initialized
          const existing = sessions.get(id);
          if (existing) {
            existing.transport = transport;
          }
        },
      });

      // Store session data with API key
      sessionData = { transport, ...newSessionKey(apiKey) };
      sessions.set(sessionId, sessionData);

      // Connect server to transport
      await mcpServer.connect(transport);
    } else {
      // A later request's header replaces the key, except the refused one a
      // client keeps re-sending after the agent signed up in this session.
      applyHeaderKey(sessionData, apiKey);
    }

    // Set session header (sessionId is always defined at this point)
    res.setHeader("mcp-session-id", sessionId!);

    // Handle the request
    await sessionData.transport.handleRequest(req, res, req.body);
  } catch (error) {
    Sentry.captureException(error);
    console.error("MCP request error:", error);
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
      id: null,
    });
  }
});

// MCP endpoint - GET for SSE (server notifications)
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  
  if (!sessionId) {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Missing mcp-session-id header" },
      id: null,
    });
  }

  const sessionData = sessions.get(sessionId);
  if (!sessionData) {
    return res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Session not found" },
      id: null,
    });
  }

  await sessionData.transport.handleRequest(req, res);
});

// MCP endpoint - DELETE to end session
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  
  if (sessionId && sessions.has(sessionId)) {
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
      await sessionData.transport.close();
    }
    sessions.delete(sessionId);
  }

  res.status(200).json({ success: true });
});

// 404 handler. Keeps the real 404 status and names where to go next, so a
// caller that guessed a path can recover without reading documentation.
app.use((req, res) => {
  res.status(404).json(notFoundDocument(req));
});

// Listen on :: for Railway private networking (IPv4 & IPv6 support)
app.listen(Number(PORT), "::", () => {
  console.log(`distribute.you MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

export default app;
