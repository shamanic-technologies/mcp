import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");

describe("railway.json", () => {
  const config = JSON.parse(
    readFileSync(resolve(ROOT, "railway.json"), "utf-8")
  );

  it("references a Dockerfile that exists", () => {
    const dockerfilePath = resolve(ROOT, config.build.dockerfilePath);
    expect(existsSync(dockerfilePath)).toBe(true);
  });

  it("uses DOCKERFILE builder", () => {
    expect(config.build.builder).toBe("DOCKERFILE");
  });

  it("has a healthcheck path", () => {
    expect(config.deploy.healthcheckPath).toBe("/health");
  });
});
