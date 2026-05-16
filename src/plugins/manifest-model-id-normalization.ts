import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestModelIdNormalizationProvider } from "./manifest.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";

type ManifestModelIdNormalizationLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

function collectManifestModelIdNormalizationPolicies(
  plugins: readonly Pick<PluginManifestRecord, "modelIdNormalization">[],
): Map<string, PluginManifestModelIdNormalizationProvider> {
  const policies = new Map<string, PluginManifestModelIdNormalizationProvider>();
  for (const plugin of plugins) {
    for (const [provider, policy] of Object.entries(plugin.modelIdNormalization?.providers ?? {})) {
      policies.set(normalizeLowercaseStringOrEmpty(provider), policy);
    }
  }
  return policies;
}

type ManifestModelIdNormalizationPolicyCache = {
  configFingerprint: string;
  earlyCacheKey: string;
  policies: Map<string, PluginManifestModelIdNormalizationProvider>;
};

let cachedPolicies: ManifestModelIdNormalizationPolicyCache | undefined;

export function resetManifestModelIdNormalizationPoliciesCache(): void {
  cachedPolicies = undefined;
}

function resolveMetadataSnapshotForPolicies(
  params: ManifestModelIdNormalizationLookupParams,
  env: NodeJS.ProcessEnv,
  workspaceDir: string | undefined,
): PluginMetadataSnapshot {
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env,
    workspaceDir,
  });
  if (current) {
    return current;
  }
  return loadPluginMetadataSnapshot({
    config: params.config ?? {},
    env,
    workspaceDir,
  });
}

function loadManifestModelIdNormalizationPolicies(
  params: ManifestModelIdNormalizationLookupParams = {},
): Map<string, PluginManifestModelIdNormalizationProvider> {
  if (params.plugins) {
    return collectManifestModelIdNormalizationPolicies(params.plugins);
  }
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  // Compute a cheap fingerprint from params alone (no snapshot load) to check the cache first.
  // This avoids calling loadPluginMetadataSnapshot on every model normalization call.
  const earlyCacheKey = resolvePluginControlPlaneFingerprint({
    config: params.config,
    env,
    workspaceDir,
  });
  if (earlyCacheKey && cachedPolicies?.earlyCacheKey === earlyCacheKey) {
    return cachedPolicies.policies;
  }
  const snapshot = resolveMetadataSnapshotForPolicies(params, env, workspaceDir);
  const configFingerprint = snapshot.configFingerprint;
  if (configFingerprint && cachedPolicies?.configFingerprint === configFingerprint) {
    if (earlyCacheKey) {
      cachedPolicies = { ...cachedPolicies, earlyCacheKey };
    }
    return cachedPolicies.policies;
  }
  const policies = collectManifestModelIdNormalizationPolicies(snapshot.plugins);
  if (configFingerprint) {
    cachedPolicies = { configFingerprint, earlyCacheKey: earlyCacheKey || "", policies };
  }
  return policies;
}

function resolveManifestModelIdNormalizationPolicy(
  provider: string,
  params: ManifestModelIdNormalizationLookupParams = {},
): PluginManifestModelIdNormalizationProvider | undefined {
  const providerId = normalizeLowercaseStringOrEmpty(provider);
  return loadManifestModelIdNormalizationPolicies(params).get(providerId);
}

function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes("/");
}

function formatPrefixedModelId(prefix: string, modelId: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}

export function normalizeProviderModelIdWithManifest(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  context: {
    provider: string;
    modelId: string;
  };
}): string | undefined {
  const policy = resolveManifestModelIdNormalizationPolicy(params.provider, params);
  if (!policy) {
    return undefined;
  }

  let modelId = params.context.modelId.trim();
  if (!modelId) {
    return modelId;
  }

  for (const prefix of policy.stripPrefixes ?? []) {
    const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
    if (normalizedPrefix && normalizeLowercaseStringOrEmpty(modelId).startsWith(normalizedPrefix)) {
      modelId = modelId.slice(prefix.length);
      break;
    }
  }

  modelId = policy.aliases?.[normalizeLowercaseStringOrEmpty(modelId)] ?? modelId;

  if (!hasProviderPrefix(modelId)) {
    for (const rule of policy.prefixWhenBareAfterAliasStartsWith ?? []) {
      if (normalizeLowercaseStringOrEmpty(modelId).startsWith(rule.modelPrefix.toLowerCase())) {
        return formatPrefixedModelId(rule.prefix, modelId);
      }
    }
    if (policy.prefixWhenBare) {
      return formatPrefixedModelId(policy.prefixWhenBare, modelId);
    }
  }

  return modelId;
}
