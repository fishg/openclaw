import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  hasAnyAuthProfileStoreSource: vi.fn(() => true),
  listProfilesForProvider: vi.fn(() => ["default"]),
  resolveEnvApiKey: vi.fn(() => null),
}));

vi.mock("../auth-profiles.js", () => ({
  externalCliDiscoveryForProviderAuth: ({ provider }: { provider: string }) => ({ provider }),
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource: mocks.hasAnyAuthProfileStoreSource,
  listProfilesForProvider: mocks.listProfilesForProvider,
}));

vi.mock("../model-auth.js", () => ({
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));

import { clearToolProviderAuthCacheForTest, hasAuthForProvider } from "./model-config.helpers.js";

describe("hasAuthForProvider process cache", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tool-auth-cache-"));
    fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), JSON.stringify({ profiles: {} }));
    mocks.ensureAuthProfileStore.mockReset().mockReturnValue({ profiles: {} });
    mocks.hasAnyAuthProfileStoreSource.mockReset().mockReturnValue(true);
    mocks.listProfilesForProvider.mockReset().mockReturnValue(["default"]);
    mocks.resolveEnvApiKey.mockReset().mockReturnValue(null);
    clearToolProviderAuthCacheForTest();
  });

  afterEach(() => {
    clearToolProviderAuthCacheForTest();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("reuses the provider auth result within the cache ttl", () => {
    expect(hasAuthForProvider({ provider: "openai-codex", agentDir })).toBe(true);
    expect(hasAuthForProvider({ provider: "openai-codex", agentDir })).toBe(true);

    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cached result when auth-profiles.json changes", async () => {
    expect(hasAuthForProvider({ provider: "openai-codex", agentDir })).toBe(true);
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({ profiles: { changed: true } }),
    );

    expect(hasAuthForProvider({ provider: "openai-codex", agentDir })).toBe(true);
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(2);
  });
});
