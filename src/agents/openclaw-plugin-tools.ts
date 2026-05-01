import { performance } from "node:perf_hooks";
import { selectApplicableRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import type { AnyAgentTool } from "./tools/common.js";

const pluginToolsDiagLog = createSubsystemLogger("agent/plugin-tools");
const MAX_PLUGIN_TOOL_CACHE_ENTRIES = 64;
const pluginToolsCache = new Map<string, AnyAgentTool[]>();

type ResolveOpenClawPluginToolsOptions = OpenClawPluginToolOptions & {
  pluginToolAllowlist?: string[];
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  sandboxRoot?: string;
  modelHasVision?: boolean;
  modelProvider?: string;
  allowMediaInvokeCommands?: boolean;
  requesterAgentIdOverride?: string;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
  disablePluginTools?: boolean;
};

function trimOrEmpty(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildPluginToolsCacheKey(params: {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
  deliveryContext: ReturnType<typeof normalizeDeliveryContext>;
}): string {
  const options = params.options;
  const existingToolNames = [...(params.existingToolNames ?? new Set<string>())].toSorted();
  const allowlist = [...(options?.pluginToolAllowlist ?? [])].toSorted();
  return JSON.stringify({
    registryVersion: getActivePluginRegistryVersion(),
    sessionKey: trimOrEmpty(options?.agentSessionKey),
    sessionId: trimOrEmpty(options?.sessionId),
    workspaceDir: trimOrEmpty(options?.workspaceDir),
    agentDir: trimOrEmpty(options?.agentDir),
    agentChannel: trimOrEmpty(options?.agentChannel),
    agentAccountId: trimOrEmpty(options?.agentAccountId),
    deliveryContext: params.deliveryContext ?? null,
    requesterSenderId: trimOrEmpty(options?.requesterSenderId),
    senderIsOwner: options?.senderIsOwner === true,
    sandboxed: options?.sandboxed === true,
    allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding === true,
    browserBridgeUrl: trimOrEmpty(options?.sandboxBrowserBridgeUrl),
    allowHostBrowserControl: options?.allowHostBrowserControl !== false,
    existingToolNames,
    allowlist,
    configPluginsEnabled: params.resolvedConfig?.plugins?.enabled ?? true,
  });
}

function getCachedPluginTools(cacheKey: string): AnyAgentTool[] | undefined {
  const cached = pluginToolsCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  pluginToolsCache.delete(cacheKey);
  pluginToolsCache.set(cacheKey, cached);
  return cached;
}

function setCachedPluginTools(cacheKey: string, tools: AnyAgentTool[]): void {
  pluginToolsCache.set(cacheKey, tools);
  while (pluginToolsCache.size > MAX_PLUGIN_TOOL_CACHE_ENTRIES) {
    const oldestKey = pluginToolsCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    pluginToolsCache.delete(oldestKey);
  }
}

export function resolveOpenClawPluginToolsForOptions(params: {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
  if (params.options?.disablePluginTools) {
    return [];
  }

  const deliveryContext = normalizeDeliveryContext({
    channel: params.options?.agentChannel,
    to: params.options?.agentTo,
    accountId: params.options?.agentAccountId,
    threadId: params.options?.agentThreadId,
  });
  const cacheKey = buildPluginToolsCacheKey({
    options: params.options,
    resolvedConfig: params.resolvedConfig,
    existingToolNames: params.existingToolNames,
    deliveryContext,
  });
  const cached = getCachedPluginTools(cacheKey);
  if (cached) {
    pluginToolsDiagLog.info(
      `[plugin-tools-cache] hit registryVersion=${getActivePluginRegistryVersion()} tools=${cached.length} sessionKey=${trimOrEmpty(params.options?.agentSessionKey) || "none"}`,
    );
    return cached;
  }

  const resolveCurrentRuntimeConfig = () => {
    const currentRuntimeSnapshot = getActiveSecretsRuntimeSnapshot();
    return selectApplicableRuntimeConfig({
      inputConfig: params.resolvedConfig ?? params.options?.config,
      runtimeConfig: currentRuntimeSnapshot?.config,
      runtimeSourceConfig: currentRuntimeSnapshot?.sourceConfig,
    });
  };
  const startedAtMs = performance.now();
  const pluginTools = resolvePluginTools({
    ...resolveOpenClawPluginToolInputs({
      options: params.options,
      resolvedConfig: params.resolvedConfig,
      runtimeConfig: resolveCurrentRuntimeConfig(),
      getRuntimeConfig: resolveCurrentRuntimeConfig,
    }),
    existingToolNames: params.existingToolNames ?? new Set<string>(),
    toolAllowlist: params.options?.pluginToolAllowlist,
    allowGatewaySubagentBinding: params.options?.allowGatewaySubagentBinding,
  });
  const resolvedTools = applyPluginToolDeliveryDefaults({
    tools: pluginTools,
    deliveryContext,
  });
  setCachedPluginTools(cacheKey, resolvedTools);
  const totalDurationMs = performance.now() - startedAtMs;
  if (totalDurationMs >= 1_000) {
    pluginToolsDiagLog.warn(
      `[plugin-tools-cache] miss totalMs=${Math.round(totalDurationMs)} registryVersion=${getActivePluginRegistryVersion()} tools=${resolvedTools.length} sessionKey=${trimOrEmpty(params.options?.agentSessionKey) || "none"}`,
    );
  }
  return resolvedTools;
}

export const __testing = {
  clearPluginToolsCache() {
    pluginToolsCache.clear();
  },
};
