import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type PnpmBuildConfig = {
  allowBuilds?: Record<string, boolean>;
  ignoredBuiltDependencies?: string[];
  onlyBuiltDependencies?: string[];
};

type RootPackageJson = {
  pnpm?: PnpmBuildConfig;
};

type WorkspaceConfig = PnpmBuildConfig;

const exoticSubdependencyReleaseAgeExclusions = [
  "@anthropic-ai/sdk",
  "@copilotkit/aimock",
  "@openclaw/fs-safe",
  "@smithy/*",
  "@vitest/*",
  "oxlint",
  "playwright-core",
  "vitest",
  "yaml",
] as const;

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

describe("package manager build policy", () => {
  it("keeps optional native Discord opus builds disabled by default", () => {
    const packageJson = readJson("package.json") as RootPackageJson;
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as WorkspaceConfig;

    expect(packageJson.pnpm).toBeUndefined();
    expect(workspace.allowBuilds?.["@discordjs/opus"]).toBe(false);
    expect(workspace.onlyBuiltDependencies ?? []).not.toContain("@discordjs/opus");
  });

  it("keeps exotic transitive packages behind pnpm release-age blocking", () => {
    const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8")) as {
      minimumReleaseAgeExclude?: string[];
    };

    for (const packageName of exoticSubdependencyReleaseAgeExclusions) {
      expect(workspace.minimumReleaseAgeExclude ?? []).not.toContain(packageName);
    }
  });
});
