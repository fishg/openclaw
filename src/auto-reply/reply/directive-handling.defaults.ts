import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const startedAt = Date.now();
  const logStage = (stage: string, extra?: string) => {
    const suffix = extra ? ` ${extra}` : "";
    console.log(`[default-model] stage=${stage} elapsedMs=${Date.now() - startedAt}${suffix}`);
  };
  const mainModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  logStage("resolve-default-model-for-agent", `provider=${mainModel.provider} model=${mainModel.model}`);
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  logStage("build-alias-index", `aliases=${aliasIndex.byAlias.size}`);
  return { defaultProvider, defaultModel, aliasIndex };
}
