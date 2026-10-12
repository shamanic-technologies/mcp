/**
 * The gateway's own catalogue of what a customer key can do, read from the
 * openapi document the gateway SERVES (`GET {gateway}/openapi.json`).
 *
 * Why this is the source and not a hand-written list: the owner's rule is that
 * the MCP and the API have the same functional scope (2026-10-12). A tool per
 * route written by hand rots the day a route is added to the gateway. The served
 * document is the gateway's customer contract: it lists the customer routes and
 * leaves the staff-only ones out, so reading it gives the MCP exactly the API's
 * surface, and a route the gateway ships tomorrow is reachable from the MCP
 * tomorrow, with no release of this server. The document is re-read every
 * CATALOG_TTL_MS.
 *
 * What a key may actually read or write inside that surface is decided by the
 * gateway on every call, never here.
 */
import { getConfigStatus } from "./api-client.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface CatalogParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string | null;
  type: string | null;
  enum?: unknown[];
}

export interface CatalogOperation {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string | null;
  summary: string;
  description: string;
  params: CatalogParam[];
  hasBody: boolean;
  bodySchema: unknown;
  needsKey: boolean;
  deprecated: boolean;
}

/**
 * Gateway operations that expose OUR internals rather than the customer's
 * account: prompt templates and their assignments, and the internal service
 * registry. Never reachable through this server, whatever the gateway answers.
 * Matched on the path template, prefix-wise.
 */
export const PLATFORM_INTERNAL_PATHS: string[] = [
  "/v1/prompts",
  "/v1/content/platform-prompts",
  "/v1/content/prompt-assignments",
  "/v1/platform/",
];

/** The gateway's infrastructure endpoints: not account capabilities. */
const NOT_CAPABILITIES = new Set(["/", "/health", "/openapi.json"]);

export function isPlatformInternal(pathTemplate: string): boolean {
  return PLATFORM_INTERNAL_PATHS.some((p) => pathTemplate === p || pathTemplate.startsWith(p.endsWith("/") ? p : `${p}/`));
}

type Json = Record<string, unknown>;

export const CATALOG_TTL_MS = 10 * 60 * 1000;

interface Compiled {
  operations: CatalogOperation[];
  components: Json;
  loadedAt: number;
}

let cache: Compiled | null = null;
let inflight: Promise<Compiled> | null = null;

/** Test seam: load a document directly instead of fetching it. */
export function loadCatalogFromDocument(doc: Json, now = Date.now()): Compiled {
  cache = compile(doc, now);
  return cache;
}

export function resetCatalog(): void {
  cache = null;
  inflight = null;
}

async function fetchDocument(): Promise<Json> {
  const url = `${getConfigStatus().apiUrl}/openapi.json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`The gateway's openapi.json answered HTTP ${res.status} (${url})`);
  return (await res.json()) as Json;
}

/**
 * The compiled catalogue. Re-read after the TTL; when a re-read fails the last
 * good copy keeps serving (the failure is logged), and with no copy at all the
 * call fails loudly rather than pretending the API has no routes.
 */
export async function getCatalog(): Promise<Compiled> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CATALOG_TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchDocument()
      .then((doc) => {
        cache = compile(doc, Date.now());
        return cache;
      })
      .catch((err) => {
        if (cache) {
          console.error("[mcp] could not refresh the gateway catalogue, serving the last copy", err);
          cache = { ...cache, loadedAt: Date.now() };
          return cache;
        }
        throw new Error(`Could not read the API catalogue from the gateway: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function compile(doc: Json, now: number): Compiled {
  const paths = (doc.paths ?? {}) as Record<string, Json>;
  const operations: CatalogOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (NOT_CAPABILITIES.has(path) || isPlatformInternal(path)) continue;
    const shared = (item.parameters ?? []) as Json[];
    for (const method of METHODS) {
      const op = item[method.toLowerCase()] as Json | undefined;
      if (!op) continue;
      const rawParams = [...shared, ...((op.parameters ?? []) as Json[])];
      const params: CatalogParam[] = [];
      for (const p of rawParams) {
        if (p.in !== "path" && p.in !== "query") continue; // header params (x-org-id, x-request-id...) are the gateway's plumbing: orgId/brandId go in the query
        const schema = (p.schema ?? {}) as Json;
        params.push({
          name: String(p.name),
          in: p.in as "path" | "query",
          required: p.required === true || p.in === "path",
          description: (p.description as string) ?? (schema.description as string) ?? null,
          type: (schema.type as string) ?? null,
          ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
        });
      }
      const body = ((op.requestBody as Json | undefined)?.content as Json | undefined)?.["application/json"] as Json | undefined;
      operations.push({
        operationId: (op.operationId as string) || `${method} ${path}`,
        method,
        path,
        tag: Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : null,
        summary: String(op.summary ?? ""),
        description: String(op.description ?? ""),
        params,
        hasBody: !!op.requestBody,
        bodySchema: body?.schema ?? null,
        needsKey: Array.isArray(op.security) && op.security.length > 0,
        deprecated: op.deprecated === true,
      });
    }
  }
  return { operations, components: ((doc.components as Json)?.schemas ?? {}) as Json, loadedAt: now };
}

// ── Search by intent ─────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  "a an the of for to in on my our me i we you your with and or by from at is are be all every each list get show give read see find what which who how do does can please that this it its".split(" "),
);

/** Words people use for a capability, mapped onto the words the gateway uses. */
const SYNONYMS: Record<string, string[]> = {
  prospect: ["lead"],
  contact: ["lead", "crm"],
  person: ["lead", "people"],
  people: ["lead"],
  mail: ["email"],
  message: ["email", "conversation"],
  reply: ["conversation", "message"],
  replied: ["conversation"],
  wrote: ["conversation"],
  said: ["conversation"],
  thread: ["conversation"],
  inbox: ["conversation"],
  unibox: ["conversation"],
  company: ["brand"],
  website: ["brand"],
  site: ["brand"],
  balance: ["billing", "account"],
  credit: ["billing"],
  money: ["billing", "revenue"],
  invoice: ["billing", "payment"],
  spend: ["cost", "billing"],
  budget: ["budget", "cap"],
  performance: ["stat"],
  result: ["stat"],
  metric: ["stat"],
  sequence: ["email", "followup"],
  "follow-up": ["followup"],
  followup: ["followup", "email"],
};

/** Crude stem: lowercase, strip plural / -ing / -ed, so "emails" finds "email". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 3 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .flatMap((t) => (t.includes("-") ? [t, ...t.split("-")] : [t]))
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

const VERB_METHOD: Record<string, HttpMethod> = {
  list: "GET", get: "GET", show: "GET", read: "GET", see: "GET", find: "GET", fetch: "GET",
  create: "POST", add: "POST", start: "POST", send: "POST", launch: "POST",
  update: "PATCH", change: "PATCH", set: "PUT", edit: "PATCH",
  delete: "DELETE", remove: "DELETE", revoke: "DELETE",
};

export interface SearchHit {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string | null;
  summary: string;
  required: string[];
  score: number;
}

export function searchOperations(ops: CatalogOperation[], query: string, limit = 10, tag?: string): SearchHit[] {
  const words = tokens(query);
  const expanded = new Map<string, number>(); // token -> weight multiplier
  for (const w of words) {
    expanded.set(w, 1);
    for (const s of SYNONYMS[w] ?? []) if (!expanded.has(stem(s))) expanded.set(stem(s), 0.8);
  }
  const wantMethod = query
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((w) => VERB_METHOD[w])
    .find(Boolean);

  const hits: SearchHit[] = [];
  for (const op of ops) {
    if (tag && (op.tag ?? "").toLowerCase() !== tag.toLowerCase()) continue;
    const fields: Array<[Set<string>, number]> = [
      [new Set(tokens(op.summary)), 3],
      [new Set(tokens(op.path.replace(/\{[^}]+\}/g, " "))), 2.5],
      [new Set(tokens(op.tag ?? "")), 2],
      [new Set(tokens(op.operationId)), 1],
      [new Set(tokens(op.description.slice(0, 600))), 1],
    ];
    let score = 0;
    let matched = 0;
    for (const [tok, mult] of expanded) {
      let best = 0;
      for (const [set, weight] of fields) if (set.has(tok)) best = Math.max(best, weight);
      if (best > 0) matched += mult === 1 ? 1 : 0;
      score += best * mult;
    }
    if (score === 0) continue;
    // Every word of the ask found somewhere beats a few found strongly.
    score += words.length ? (matched / words.length) * 3 : 0;
    if (wantMethod && op.method === wantMethod) score += 1.5;
    if (op.deprecated) score -= 2;
    hits.push({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      tag: op.tag,
      summary: op.summary,
      required: op.params.filter((p) => p.required).map((p) => `${p.name} (${p.in})`),
      score: Math.round(score * 10) / 10,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return hits.slice(0, limit);
}

// ── Lookup and path matching ────────────────────────────────────────────────

export function findOperation(
  ops: CatalogOperation[],
  ref: { operationId?: string; method?: string; path?: string },
): CatalogOperation | null {
  if (ref.operationId) {
    const byId = ops.find((o) => o.operationId === ref.operationId);
    if (byId) return byId;
  }
  if (ref.method && ref.path) {
    const m = ref.method.toUpperCase();
    return ops.find((o) => o.method === m && o.path === ref.path) ?? matchPath(ops, m, ref.path)?.operation ?? null;
  }
  return null;
}

function templateRegex(template: string): RegExp {
  const src = template
    .split("/")
    .map((seg) => (/^\{[^}]+\}$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${src}$`);
}

const literalSegments = (template: string) => template.split("/").filter((s) => s && !s.startsWith("{")).length;

/**
 * The operation a concrete path (`/v1/leads/abc`) is an instance of. When
 * several templates fit (`/v1/leads/stats` and `/v1/leads/{id}`), the one with
 * the most literal segments wins, which is how the gateway's router reads it.
 * Returns the templates that fit the path under ANY method when none fits this one.
 */
export function matchPath(
  ops: CatalogOperation[],
  method: string,
  path: string,
): { operation: CatalogOperation | null; otherMethods: HttpMethod[] } | null {
  const fitting = ops.filter((o) => templateRegex(o.path).test(path));
  if (fitting.length === 0) return null;
  const sameMethod = fitting.filter((o) => o.method === method.toUpperCase());
  sameMethod.sort((a, b) => literalSegments(b.path) - literalSegments(a.path));
  return {
    operation: sameMethod[0] ?? null,
    otherMethods: [...new Set(fitting.map((o) => o.method))],
  };
}

/**
 * A JSON schema with its `$ref`s inlined, depth-limited, so an assistant reads a
 * request body's shape in one call. A ref deeper than `depth` is left as its name.
 */
export function resolveSchema(schema: unknown, components: Json, depth = 4): unknown {
  if (Array.isArray(schema)) return schema.map((s) => resolveSchema(s, components, depth));
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Json;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.split("/").pop() as string;
    if (depth <= 0 || !(name in components)) return { $ref: name };
    return resolveSchema(components[name], components, depth - 1);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveSchema(v, components, depth)]));
}
