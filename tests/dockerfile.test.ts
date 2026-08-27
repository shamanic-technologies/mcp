import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
};

/**
 * `pnpm deploy` exits 0 when its --filter matches nothing, so a stale filter in
 * the Dockerfile does not fail at that step. It fails two steps later on a `cp`
 * into a /prod that was never created, which names neither the filter nor the
 * rename that broke it. Renaming the workspace package therefore broke every
 * production build silently. Keep the two in sync here instead.
 */
describe("Dockerfile", () => {
  it("filters pnpm deploy on the name package.json actually declares", () => {
    const filters = [...dockerfile.matchAll(/^RUN pnpm deploy .*?--filter\s+(\S+)/gm)].map((m) =>
      m[1].replace(/^["']|["']$/g, ""),
    );

    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) {
      expect(filter).toBe(pkg.name);
    }
  });

  it("fails the build when pnpm deploy produces no /prod", () => {
    expect(dockerfile).toMatch(/test -d \/prod/);
  });
});
