import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(() => ({ plugins: [], diagnostics: [] })),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));

import { buildMediaUnderstandingManifestMetadataRegistry } from "./manifest-metadata.js";

function createMediaPlugin(): PluginManifestRecord {
  return {
    id: "media-demo",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: "/plugins/media-demo",
    source: "/plugins/media-demo/openclaw.plugin.json",
    manifestPath: "/plugins/media-demo/openclaw.plugin.json",
    contracts: { mediaUnderstandingProviders: ["demo-media"] },
    mediaUnderstandingProviderMetadata: {
      "demo-media": {
        capabilities: ["image"],
        defaultModels: { image: "demo-vision" },
        autoPriority: { image: 1 },
        nativeDocumentInputs: ["pdf"],
      },
    },
  };
}

function createSnapshot(params: {
  config?: OpenClawConfig;
  plugins?: PluginManifestRecord[];
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  return {
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: params.plugins ?? [], diagnostics: [] },
    plugins: params.plugins ?? [],
    diagnostics: [],
    byPluginId: new Map((params.plugins ?? []).map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: params.plugins?.length ?? 0,
    },
  };
}

describe("buildMediaUnderstandingManifestMetadataRegistry", () => {
  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockClear();
  });

  it("reuses the gateway snapshot for workspace calls when no workspace plugins exist", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-media-workspace-"));
    const config = { plugins: { allow: ["media-demo"] } };
    setCurrentPluginMetadataSnapshot(createSnapshot({ config, plugins: [createMediaPlugin()] }), {
      config,
    });

    const registry = buildMediaUnderstandingManifestMetadataRegistry(config, workspaceDir);

    expect(registry.get("demo-media")).toMatchObject({
      id: "demo-media",
      defaultModels: { image: "demo-vision" },
    });
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
  });

  it("does not reuse an unscoped snapshot when workspace plugins are present", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-media-workspace-"));
    fs.mkdirSync(path.join(workspaceDir, ".openclaw", "extensions", "local"), {
      recursive: true,
    });
    const config = { plugins: { allow: ["media-demo"] } };
    setCurrentPluginMetadataSnapshot(createSnapshot({ config, plugins: [createMediaPlugin()] }), {
      config,
    });

    const registry = buildMediaUnderstandingManifestMetadataRegistry(config, workspaceDir);

    expect(registry.has("demo-media")).toBe(false);
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);
  });
});
