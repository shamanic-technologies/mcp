/**
 * The gateway's own catalogue of what a key can do, read from the openapi
 * document the gateway SERVES for that key (`GET {gateway}/v1/me/openapi.json`),
 * or its public one (`GET {gateway}/openapi.json`) for a session with no key.
 *
 * Why this is the source and not a hand-written list: the owner's rule is that
 * the MCP and the API have the same functional scope (2026-10-12). A tool per
 * route written by hand rots the day a route is added to the gateway. The served
 * document is the gateway's customer contract: it lists the customer routes and
 * leaves the staff-only ones out, so reading it gives the MCP exactly the API's
 * surface, and a route the gateway ships is reachable from the MCP the moment
 * the gateway serves it, with no release of this server.
 *
 * No staleness window (owner 2026-10-12: a route added to the API is reachable
 * from the MCP with NO delay). Every discovery call asks the gateway, with a
 * HEAD, for the ETag of the document it serves NOW for that key; the compiled
 * copy is reused only while that ETag is unchanged, and re-read the moment it
 * differs. A gateway that sends no ETag gets its document re-read on every call.
 *
 * Each key gets its own document: a staff user's key is served, on top of the
 * public operations, the few a staff key may call (`x-staff-only: true`, e.g.
 * create an organization for a new client), and a client key is never served
 * them. So the catalogue is cached per key, and one key's copy never answers
 * another key's session. Which key is staff is the gateway's call, not ours.
 *
 * What a key may actually read or write inside that surface is decided by the
 * gateway on every call, never here.
 */
import { createHash } from "node:crypto";
import { callApi, getApiKey, getConfigStatus, headApi } from "./api-client.js";

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
  /** Served only to a staff user's key (`x-staff-only: true`). The gateway still decides on each call. */
  staffOnly: boolean;
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

interface Compiled {
  operations: CatalogOperation[];
  components: Json;
  loadedAt: number;
  /** The gateway's ETag for the document this copy was compiled from (null: none sent, never reused). */
  etag?: string | null;
  /** Test seam only: a copy loaded by hand is served without asking the gateway. */
  pinned?: boolean;
}

/** At most this many keys' catalogues are held; the oldest is dropped first. */
const MAX_CACHED_KEYS = 200;

const cache = new Map<string, Compiled>();
const inflight = new Map<string, Promise<Compiled>>();

/** The cache slot of a key: a hash, so no key sits in memory as a map key; "public" for none. */
export function catalogSlot(key: string | null): string {
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 32) : "public";
}

/** Test seam: load a document directly instead of fetching it, for `key` (default: the call's key). */
export function loadCatalogFromDocument(doc: Json, now = Date.now(), key: string | null = getApiKey()): Compiled {
  const compiled = { ...compile(doc, now), pinned: true };
  cache.set(catalogSlot(key), compiled);
  return compiled;
}

export function resetCatalog(): void {
  cache.clear();
  inflight.clear();
}

async function fetchPublicDocument(): Promise<Json> {
  const url = `${getConfigStatus().apiUrl}/openapi.json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`The gateway's openapi.json answered HTTP ${res.status} (${url})`);
  return (await res.json()) as Json;
}

/**
 * The document the gateway serves for `key`. A key the gateway refuses (401,
 * 403) reads the public document, as a session with no key does: that is what
 * the gateway's contract says such a key may see. Any other failure is thrown.
 */
async function fetchDocument(key: string | null): Promise<Json> {
  if (!key) return fetchPublicDocument();
  const res = await callApi<Json>("/v1/me/openapi.json", { apiKey: key, mcpTool: "distribute_find_api (catalogue)" });
  if (res.status === 401 || res.status === 403) return fetchPublicDocument();
  if (res.error || !res.data || typeof res.data !== "object") {
    throw new Error(`The gateway's /v1/me/openapi.json answered ${res.status ? `HTTP ${res.status}` : "nothing"}: ${res.error ?? "not a JSON document"}`);
  }
  return res.data;
}

/**
 * The ETag of the document the gateway serves NOW for `key` (the public one for
 * no key, or a key it refuses, as fetchDocument reads). Throws when the check
 * itself fails: serving a copy that may be out of date is what this replaces.
 */
async function servedVersion(key: string | null): Promise<string | null> {
  const tool = "distribute_find_api (catalogue check)";
  if (key) {
    const own = await headApi("/v1/me/openapi.json", { apiKey: key, mcpTool: tool });
    if (own.status !== 401 && own.status !== 403) {
      if (own.error) throw new Error(`The gateway's /v1/me/openapi.json check answered ${own.error}`);
      return own.etag;
    }
  }
  const pub = await headApi("/openapi.json", { apiKey: null, mcpTool: tool });
  if (pub.error) throw new Error(`The gateway's /openapi.json check answered ${pub.error}`);
  return pub.etag;
}

/**
 * The compiled catalogue for the key of the call being served, exactly as the
 * gateway serves it now: the held copy is reused only when the gateway's ETag
 * for it is unchanged (checked on this call), and re-read otherwise. With no
 * copy that can be confirmed current, the call fails loudly rather than search
 * a list that may be out of date, or pretend the API has no routes.
 */
export async function getCatalog(): Promise<Compiled> {
  const key = getApiKey();
  const slot = catalogSlot(key);
  const held = cache.get(slot);
  if (held?.pinned) return held;
  let etag: string | null;
  try {
    etag = await servedVersion(key);
  } catch (err) {
    throw new Error(`Could not read the API catalogue from the gateway: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (held && etag && held.etag === etag) return held;
  const flight = `${slot}|${etag ?? `none-${Date.now()}`}`;
  let pending = inflight.get(flight);
  if (!pending) {
    pending = fetchDocument(key)
      .then((doc) => store(slot, { ...compile(doc, Date.now()), etag }))
      .catch((err) => {
        throw new Error(`Could not read the API catalogue from the gateway: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        inflight.delete(flight);
      });
    inflight.set(flight, pending);
  }
  return pending;
}

function store(slot: string, compiled: Compiled): Compiled {
  cache.delete(slot);
  cache.set(slot, compiled);
  while (cache.size > MAX_CACHED_KEYS) cache.delete(cache.keys().next().value as string);
  return compiled;
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
        staffOnly: op["x-staff-only"] === true,
      });
    }
  }
  return { operations, components: ((doc.components as Json)?.schemas ?? {}) as Json, loadedAt: now };
}

// ── Search by intent ─────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  "a an the of for to in on my our me i we you your with and or by from at is are be all every each list get show give read see find what which who how do does did done was were has have had when where can please that this it its".split(" "),
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
  // A campaign IS a sales funnel campaign, and its money is its caps (a max budget and/or a max
  // volume per period): today's words for it land on the funnel and its caps.
  campaign: ["funnel"],
  budget: ["budget", "cap"],
  max: ["cap"],
  cap: ["max"],
  volume: ["cap", "max"],
  limit: ["cap", "max"],
  catalog: ["catalogue", "price"],
  catalogue: ["price"],
  price: ["catalogue", "cost"],
  priced: ["price", "catalogue"],
  cost: ["price"],
  // The gateway states a cap rather than setting it.
  set: ["state"],
  change: ["state", "update"],
  day: ["daily"],
  week: ["weekly"],
  month: ["monthly"],
  performance: ["stat"],
  result: ["stat"],
  metric: ["stat"],
  sequence: ["email", "followup"],
  "follow-up": ["followup"],
  followup: ["followup", "email"],
  org: ["organization"],
  organization: ["org"],
  client: ["organization", "org"],
  customer: ["organization", "org"],
  account: ["organization"],
  invite: ["invitation", "member"],
  invitation: ["invite", "member"],
  teammate: ["member", "invite"],
  colleague: ["member", "invite"],
  member: ["invite", "invitation"],
  grant: ["credit", "free"],
  free: ["credit", "grant"],
  gift: ["credit", "grant"],
  answer: ["reply", "conversation"],
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
  delete: "DELETE", remove: "DELETE", revoke: "DELETE", cancel: "DELETE",
  grant: "POST", invite: "POST", open: "POST",
  cap: "PUT", limit: "PUT",
};

/**
 * Verbs that only say what to DO when they open the ask: "reply to Ann" is a
 * write, "what did Ann reply" is a read.
 */
const LEADING_VERB_METHOD: Record<string, HttpMethod> = {
  reply: "POST", answer: "POST",
  // A question asks to read.
  what: "GET", who: "GET", did: "GET", has: "GET", have: "GET", how: "GET", when: "GET", which: "GET", is: "GET", are: "GET",
};

export interface SearchHit {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string | null;
  summary: string;
  required: string[];
  /** Present (true) only on an operation the gateway serves to a staff user's key alone. */
  staffOnly?: true;
  score: number;
}

export function searchOperations(ops: CatalogOperation[], query: string, limit = 10, tag?: string): SearchHit[] {
  const words = [...new Set(tokens(query))];
  // Each word of the ask, with the gateway words it may appear as.
  const asked = words.map((w) => ({
    forms: [[w, 1] as [string, number], ...(SYNONYMS[w] ?? []).map((s) => [stem(s), 0.8] as [string, number]).filter(([s]) => s !== w)],
  }));
  const rawWords = query.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const wantMethod = LEADING_VERB_METHOD[rawWords[0] ?? ""] ?? rawWords.map((w) => VERB_METHOD[w]).find(Boolean);

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
    for (const { forms } of asked) {
      let best = 0;
      for (const [tok, mult] of forms) for (const [set, weight] of fields) if (set.has(tok)) best = Math.max(best, weight * mult);
      if (best > 0) matched += 1;
      score += best;
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
      ...(op.staffOnly ? { staffOnly: true as const } : {}),
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
