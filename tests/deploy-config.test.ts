import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");

describe("deploy config", () => {
  it("builds from a Dockerfile at the repo root", () => {
    expect(existsSync(resolve(ROOT, "Dockerfile"))).toBe(true);
  });

  it("keeps no config for the retired Railway platform", () => {
    expect(existsSync(resolve(ROOT, "railway.json"))).toBe(false);
  });

  it("deploys the package under its current name", () => {
    const dockerfile = readFileSync(resolve(ROOT, "Dockerfile"), "utf-8");
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      name: string;
    };
    expect(dockerfile).toContain(`--filter ${pkg.name}`);
  });

  it("stays private — this is a remote HTTP server, not a published package", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      private: boolean;
    };
    expect(pkg.private).toBe(true);
  });
});
