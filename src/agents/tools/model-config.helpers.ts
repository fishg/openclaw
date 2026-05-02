import fs from "node:fs";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  resolveAgentModelTimeoutMsValue,
} from "../../config/model-input.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  hasAnyAuthProfileStoreSource,
  listProfilesForProvider,
} from "../auth-profiles.js";
import { resolveAuthStorePath } from "../auth-profiles/path-resolve.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveEnvApiKey } from "../model-auth.js";
import { resolveConfiguredModelRef } from "../model-selection.js";

export type ToolModelConfig = { primary?: string; fallbacks?: string[]; timeoutMs?: number };
const TOOL_PROVIDER_AUTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type ToolProviderAuthCacheEntry = {
  fingerprint: string;
  value: boolean;
  expiresAt: number;
};

const toolProviderAuthCache = new Map<string, ToolProviderAuthCacheEntry>();

function safeStatFingerprint(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function buildToolProviderAuthFingerprint(agentDir: string): string {
  const requestedAuthPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  const parts = [safeStatFingerprint(requestedAuthPath)];
  if (requestedAuthPath !== mainAuthPath) {
    parts.push(safeStatFingerprint(mainAuthPath));
  }
  return parts.join("|");
}

export function clearToolProviderAuthCacheForTest(): void {
  toolProviderAuthCache.clear();
}

export function hasToolModelConfig(model: ToolModelConfig | undefined): boolean {
  return Boolean(
    model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0),
  );
}

export function resolveDefaultModelRef(cfg?: OpenClawConfig): { provider: string; model: string } {
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    return { provider: resolved.provider, model: resolved.model };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

export function hasAuthForProvider(params: {
  provider: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  const agentDir = params.agentDir?.trim();
  if (agentDir) {
    const cacheKey = `${agentDir}\u0000${params.provider.trim()}`;
    const fingerprint = buildToolProviderAuthFingerprint(agentDir);
    const cached = toolProviderAuthCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now && cached.fingerprint === fingerprint) {
      return cached.value;
    }
    const value = (() => {
      if (params.authStore) {
        return listProfilesForProvider(params.authStore, params.provider).length > 0;
      }
      if (!hasAnyAuthProfileStoreSource(agentDir)) {
        return false;
      }
      const store = ensureAuthProfileStore(agentDir, {
        externalCli: externalCliDiscoveryForProviderAuth({ provider: params.provider }),
      });
      return listProfilesForProvider(store, params.provider).length > 0;
    })();
    toolProviderAuthCache.set(cacheKey, {
      fingerprint,
      value,
      expiresAt: now + TOOL_PROVIDER_AUTH_CACHE_TTL_MS,
    });
    return value;
  }
  if (params.authStore) {
    return listProfilesForProvider(params.authStore, params.provider).length > 0;
  }
  return false;
}

export function coerceToolModelConfig(model?: AgentModelConfig): ToolModelConfig {
  const primary = resolveAgentModelPrimaryValue(model);
  const fallbacks = resolveAgentModelFallbackValues(model);
  const timeoutMs = resolveAgentModelTimeoutMsValue(model);
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function buildToolModelConfigFromCandidates(params: {
  explicit: ToolModelConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  candidates: Array<string | null | undefined>;
  isProviderConfigured?: (provider: string) => boolean;
}): ToolModelConfig | null {
  if (hasToolModelConfig(params.explicit)) {
    return params.explicit;
  }

  const deduped: string[] = [];
  for (const candidate of params.candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed || !trimmed.includes("/")) {
      continue;
    }
    const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
    const providerConfigured =
      params.isProviderConfigured?.(provider) ??
      hasAuthForProvider({
        provider,
        agentDir: params.agentDir,
        authStore: params.authStore,
      });
    if (!provider || !providerConfigured) {
      continue;
    }
    if (!deduped.includes(trimmed)) {
      deduped.push(trimmed);
    }
  }

  if (deduped.length === 0) {
    return null;
  }

  return {
    primary: deduped[0],
    ...(deduped.length > 1 ? { fallbacks: deduped.slice(1) } : {}),
    ...(params.explicit.timeoutMs !== undefined ? { timeoutMs: params.explicit.timeoutMs } : {}),
  };
}
