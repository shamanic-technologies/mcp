/**
 * Which key an MCP session calls with.
 *
 * A client sends its configured `Authorization` header on EVERY request, so a
 * session opened with a placeholder or dead key (`distrib.usr_YOUR_KEY`, copied
 * from a landing page) keeps re-sending it. After the agent signs up in that
 * session, the minted key must win over that refused header, or the agent stays
 * on "Invalid API key" with a working key in hand. A session whose key works is
 * untouched: it keeps its key, and a new header still replaces it.
 */
export interface SessionKey {
  /** The key the next tool call is made with. */
  apiKey: string | null;
  /** A key the gateway answered 401 to, while it was this session's key. */
  refusedKey: string | null;
  /** The key distribute_signup_complete minted in this session, once adopted. */
  mintedKey: string | null;
}

export function newSessionKey(headerKey: string | null): SessionKey {
  return { apiKey: headerKey, refusedKey: null, mintedKey: null };
}

/** A later request's header. The refused key the client keeps re-sending does not undo a signup. */
export function applyHeaderKey(s: SessionKey, headerKey: string | null): void {
  if (!headerKey) return;
  if (s.mintedKey && headerKey === s.refusedKey) return;
  s.apiKey = headerKey;
}

/** The gateway refused `key`: remembered only if it is the session's own key. */
export function noteKeyRefused(s: SessionKey, key: string): void {
  if (key === s.apiKey) s.refusedKey = key;
}

/**
 * A signup minted `minted`. Adopted when the session has no key, or its key is
 * refused. `isRefused` checks a key no call has tried yet (an agent that signs
 * up before any other call); it is not called when the answer is already known.
 */
export async function adoptMintedKey(
  s: SessionKey,
  minted: string,
  isRefused: (key: string) => Promise<boolean>,
): Promise<void> {
  const current = s.apiKey;
  if (current && current !== s.refusedKey) {
    if (!(await isRefused(current))) return;
    s.refusedKey = current;
  }
  s.apiKey = minted;
  s.mintedKey = minted;
}
