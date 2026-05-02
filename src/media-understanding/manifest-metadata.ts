import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { resolvePluginSourceRoots } from "../plugins/roots.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

function workspacePluginRootHasEntries(workspaceDir: string | undefined): boolean {
  if (!workspaceDir) {
    return false;
  }
  const workspacePluginRoot = resolvePluginSourceRoots({ workspaceDir }).workspace;
  if (!workspacePluginRoot) {
    return false;
  }
  try {
    return fs.readdirSync(workspacePluginRoot).some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

export function buildMediaUnderstandingManifestMetadataRegistry(
  cfg?: OpenClawConfig,
  workspaceDir?: string,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  const snapshot =
    getCurrentPluginMetadataSnapshot({
      config: cfg,
      ...(workspaceDir ? { workspaceDir } : {}),
    }) ??
    (workspacePluginRootHasEntries(workspaceDir)
      ? undefined
      : getCurrentPluginMetadataSnapshot({ config: cfg }));
  const plugins =
    snapshot?.plugins ??
    loadPluginManifestRegistryForPluginRegistry({
      config: cfg,
      env: process.env,
      includeDisabled: true,
      ...(workspaceDir ? { workspaceDir } : {}),
    }).plugins;
  for (const plugin of plugins) {
    const declaredProviders = new Set(
      (plugin.contracts?.mediaUnderstandingProviders ?? []).map((providerId) =>
        normalizeMediaProviderId(providerId),
      ),
    );
    for (const [providerId, metadata] of Object.entries(
      plugin.mediaUnderstandingProviderMetadata ?? {},
    )) {
      const normalizedProviderId = normalizeMediaProviderId(providerId);
      if (!normalizedProviderId || !declaredProviders.has(normalizedProviderId)) {
        continue;
      }
      registry.set(normalizedProviderId, {
        id: normalizedProviderId,
        capabilities: metadata.capabilities,
        defaultModels: metadata.defaultModels,
        autoPriority: metadata.autoPriority,
        nativeDocumentInputs: metadata.nativeDocumentInputs,
      });
    }
  }
  return registry;
}
