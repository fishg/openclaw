import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { PluginLruCache, createPluginCacheKey } from "../../plugins/plugin-cache-primitives.js";
import { resolvePluginControlPlaneFingerprint } from "../../plugins/plugin-control-plane-context.js";

type DefaultModelResolution = {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
};

const defaultModelResolutionCache = new PluginLruCache<DefaultModelResolution>(128);
const defaultModelResolutionLog = createSubsystemLogger("auto-reply/resolve-default-model");
const DEFAULT_MODEL_RESOLUTION_SLOW_MS = 250;

function cloneDefaultModelResolution(resolution: DefaultModelResolution): DefaultModelResolution {
  return {
    defaultProvider: resolution.defaultProvider,
    defaultModel: resolution.defaultModel,
    aliasIndex: {
      byAlias: new Map(resolution.aliasIndex.byAlias),
      byKey: new Map(
        [...resolution.aliasIndex.byKey.entries()].map(([key, aliases]) => [key, [...aliases]]),
      ),
    },
  };
}

function logDefaultModelResolution(params: {
  outcome: "hit" | "miss";
  totalMs: number;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
  stages: string[];
}) {
  const message =
    `[diag:cpu] resolve-default-model outcome=${params.outcome}` +
    ` totalMs=${params.totalMs}` +
    ` agentId=${params.agentId ?? "n/a"}` +
    ` provider=${params.defaultProvider}` +
    ` model=${params.defaultModel}` +
    ` stages=${params.stages.length > 0 ? params.stages.join(",") : "none"}`;
  if (params.totalMs >= DEFAULT_MODEL_RESOLUTION_SLOW_MS) {
    defaultModelResolutionLog.warn(message);
  } else {
    defaultModelResolutionLog.info(message);
  }
}

export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const startedAt = Date.now();
  let previousAt = startedAt;
  const stages: string[] = [];
  const mark = (name: string) => {
    const now = Date.now();
    stages.push(`${name}:${Math.max(0, now - previousAt)}ms@${Math.max(0, now - startedAt)}ms`);
    previousAt = now;
  };
  const cacheKey = createPluginCacheKey([
    params.agentId ?? "",
    resolvePluginControlPlaneFingerprint({ config: params.cfg }),
    params.cfg.agents?.defaults?.model ?? null,
    params.cfg.agents?.defaults?.models ?? null,
    params.cfg.models?.providers ?? null,
  ]);
  mark("build-cache-key");
  const cached = defaultModelResolutionCache.get(cacheKey);
  if (cached) {
    mark("cache-hit");
    logDefaultModelResolution({
      outcome: "hit",
      totalMs: Math.max(0, Date.now() - startedAt),
      agentId: params.agentId,
      defaultProvider: cached.defaultProvider,
      defaultModel: cached.defaultModel,
      stages,
    });
    return cloneDefaultModelResolution(cached);
  }

  const mainModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    allowPluginNormalization: false,
  });
  mark("resolve-default-model-for-agent");
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
    allowPluginNormalization: false,
  });
  mark("build-model-alias-index");
  const resolved = { defaultProvider, defaultModel, aliasIndex };
  defaultModelResolutionCache.set(cacheKey, resolved);
  mark("cache-set");
  logDefaultModelResolution({
    outcome: "miss",
    totalMs: Math.max(0, Date.now() - startedAt),
    agentId: params.agentId,
    defaultProvider,
    defaultModel,
    stages,
  });
  return cloneDefaultModelResolution(resolved);
}
