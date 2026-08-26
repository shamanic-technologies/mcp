// IMPORTANT: Import instrument first to initialize Sentry before anything else
import "./instrument.js";
import * as Sentry from "@sentry/node";
import express, { Request, Response, Express } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toolDefinitions, handleToolCall } from "./tools/index.js";
import { setApiKey } from "./lib/api-client.js";
import { discoveryDocument, notFoundDocument, SERVER_NAME, SERVER_VERSION } from "./discovery.js";

const PORT = process.env.PORT || 3000;

// Create Express app
const app: Express = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
  exposedHeaders: ["mcp-session-id"],
}));

app.use(express.json());

// Session data includes transport and API key
interface SessionData {
  transport: StreamableHTTPServerTransport;
  apiKey: string | null;
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
            // Set the API key for this request context
            const session = sessions.get(sessionId!);
            if (session?.apiKey) {
              setApiKey(session.apiKey);
            }
            
            const result = await handleToolCall(name, args);
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
      sessionData = { transport, apiKey };
      sessions.set(sessionId, sessionData);

      // Connect server to transport
      await mcpServer.connect(transport);
    } else if (apiKey) {
      // Update API key if provided in subsequent requests
      sessionData.apiKey = apiKey;
    }

    // Set API key for this request
    if (sessionData.apiKey) {
      setApiKey(sessionData.apiKey);
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

  // Set API key for this request context
  if (sessionData.apiKey) {
    setApiKey(sessionData.apiKey);
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
  console.log(`distribute MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

export default app;
