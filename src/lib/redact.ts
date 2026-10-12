/**
 * Fields this server never hands to a customer's assistant, at any depth of any
 * response, whatever the gateway served.
 *
 * INTERNAL: how WE produced the work (the prompt we wrote, the model that ran it,
 * its token counts, the generation run and its vendor costs). The gateway is being
 * fixed to stop serving them on customer routes; this is the second lock, so an
 * MCP client never re-exposes them even while a gateway route still leaks them.
 *
 * OPENS: not a number this platform reports anywhere (Apple Mail Privacy
 * Protection pre-fetches images, so an open count measures the proxy). The funnel
 * is sent, click, positive reply.
 */
export const INTERNAL_FIELDS = new Set([
  "promptRaw",
  "responseRaw",
  "variablesRaw",
  "promptType",
  "model",
  "tokensInput",
  "tokensOutput",
  "generationRun",
]);

export const OPEN_FIELDS = new Set(["opened", "openRate", "opens", "firstOpenedAt", "openedAt"]);

export function withoutFields(value: unknown, drop: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutFields(v, drop));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !drop.has(k))
        .map(([k, v]) => [k, withoutFields(v, drop)]),
    );
  }
  return value;
}

const CUSTOMER_UNSAFE = new Set([...INTERNAL_FIELDS, ...OPEN_FIELDS]);

/** A gateway response as a customer's assistant may read it. */
export function forCustomer(value: unknown): unknown {
  return withoutFields(value, CUSTOMER_UNSAFE);
}
