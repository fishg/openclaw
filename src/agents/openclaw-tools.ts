import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { createSubsystemLogger } from "../logging.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import {
  collectPresentOpenClawTools,
  isUpdatePlanToolEnabledForOpenClawTools,
} from "./openclaw-tools.registration.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type OpenClawToolsDeps = {
  callGateway: typeof callGateway;
  config?: OpenClawConfig;
};

const defaultOpenClawToolsDeps: OpenClawToolsDeps = {
  callGateway,
};

let openClawToolsDeps: OpenClawToolsDeps = defaultOpenClawToolsDeps;
const openClawToolsDiagLog = createSubsystemLogger("agent/openclaw-tools");

function measureOpenClawToolsStep<T>(
  segments: Record<string, number>,
  name: string,
  fn: () => T,
): T {
  const startedAtMs = performance.now();
  try {
    return fn();
  } finally {
    segments[name] = (segments[name] ?? 0) + performance.now() - startedAtMs;
  }
}

function formatTimingSegments(segments: Record<string, number>): string {
  return Object.entries(segments)
    .map(([name, durationMs]) => `${name}:${Math.round(durationMs)}ms`)
    .join(",");
}

export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxContainerWorkdir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks. */
    currentMessageId?: string | number;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: { value: boolean };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Active model provider for provider-specific tool gating. */
    modelProvider?: string;
    /** Active model id for provider/model-specific tool gating. */
    modelId?: string;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Restrict the cron tool to self-removing this active cron job. */
    cronSelfRemoveOnlyJobId?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
  } & SpawnedToolContext,
): AnyAgentTool[] {
  const startedAtMs = performance.now();
  const preludeSegments: Record<string, number> = {};
  const resolvedConfig = options?.config ?? openClawToolsDeps.config;
  const { sessionAgentId } = measureOpenClawToolsStep(
    preludeSegments,
    "resolveSessionAgentIds",
    () =>
      resolveSessionAgentIds({
        sessionKey: options?.agentSessionKey,
        config: resolvedConfig,
        agentId: options?.requesterAgentIdOverride,
      }),
  );
  // Fall back to the session agent workspace so plugin loading stays workspace-stable
  // even when a caller forgets to thread workspaceDir explicitly.
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : measureOpenClawToolsStep(preludeSegments, "resolveAgentWorkspaceDir", () =>
          resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId),
        );
  const workspaceDir = measureOpenClawToolsStep(preludeSegments, "resolveWorkspaceRoot", () =>
    resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir),
  );
  const spawnWorkspaceDir = measureOpenClawToolsStep(
    preludeSegments,
    "resolveSpawnWorkspaceRoot",
    () =>
      resolveWorkspaceRoot(
        options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir,
      ),
  );
  const deliveryContext = measureOpenClawToolsStep(
    preludeSegments,
    "normalizeDeliveryContext",
    () =>
      normalizeDeliveryContext({
        channel: options?.agentChannel,
        to: options?.agentTo,
        accountId: options?.agentAccountId,
        threadId: options?.agentThreadId,
      }),
  );
  const runtimeWebTools = measureOpenClawToolsStep(
    preludeSegments,
    "getActiveRuntimeWebToolsMetadata",
    getActiveRuntimeWebToolsMetadata,
  );
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  const imageTool = options?.agentDir?.trim()
    ? measureOpenClawToolsStep(preludeSegments, "createImageTool", () =>
        createImageTool({
          config: options?.config,
          agentDir: options.agentDir,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          modelHasVision: options?.modelHasVision,
        }),
      )
    : null;
  const imageGenerateTool = measureOpenClawToolsStep(
    preludeSegments,
    "createImageGenerateTool",
    () =>
      createImageGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      }),
  );
  const videoGenerateTool = measureOpenClawToolsStep(
    preludeSegments,
    "createVideoGenerateTool",
    () =>
      createVideoGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      }),
  );
  const musicGenerateTool = measureOpenClawToolsStep(
    preludeSegments,
    "createMusicGenerateTool",
    () =>
      createMusicGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      }),
  );
  const pdfTool = options?.agentDir?.trim()
    ? measureOpenClawToolsStep(preludeSegments, "createPdfTool", () =>
        createPdfTool({
          config: options?.config,
          agentDir: options.agentDir,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
        }),
      )
    : null;
  const webSearchTool = measureOpenClawToolsStep(preludeSegments, "createWebSearchTool", () =>
    createWebSearchTool({
      config: options?.config,
      sandboxed: options?.sandboxed,
      runtimeWebSearch: runtimeWebTools?.search,
    }),
  );
  const webFetchTool = measureOpenClawToolsStep(preludeSegments, "createWebFetchTool", () =>
    createWebFetchTool({
      config: options?.config,
      sandboxed: options?.sandboxed,
      runtimeWebFetch: runtimeWebTools?.fetch,
    }),
  );
  const messageTool = options?.disableMessageTool
    ? null
    : measureOpenClawToolsStep(preludeSegments, "createMessageTool", () =>
        createMessageTool({
          agentAccountId: options?.agentAccountId,
          agentSessionKey: options?.agentSessionKey,
          sessionId: options?.sessionId,
          config: options?.config,
          currentChannelId: options?.currentChannelId,
          currentChannelProvider: options?.agentChannel,
          currentThreadTs: options?.currentThreadTs,
          currentMessageId: options?.currentMessageId,
          replyToMode: options?.replyToMode,
          hasRepliedRef: options?.hasRepliedRef,
          sandboxRoot: options?.sandboxRoot,
          requireExplicitTarget: options?.requireExplicitMessageTarget,
          requesterSenderId: options?.requesterSenderId ?? undefined,
          senderIsOwner: options?.senderIsOwner,
        }),
      );
  const nodesToolBase = measureOpenClawToolsStep(preludeSegments, "createNodesTool", () =>
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      config: options?.config,
      modelHasVision: options?.modelHasVision,
      allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
    }),
  );
  const nodesTool = measureOpenClawToolsStep(preludeSegments, "applyNodesToolWorkspaceGuard", () =>
    applyNodesToolWorkspaceGuard(nodesToolBase, {
      fsPolicy: options?.fsPolicy,
      sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
      sandboxRoot: options?.sandboxRoot,
      workspaceDir,
    }),
  );
  const embedded = measureOpenClawToolsStep(preludeSegments, "isEmbeddedMode", isEmbeddedMode);
  const effectiveCallGateway = embedded
    ? measureOpenClawToolsStep(
        preludeSegments,
        "createEmbeddedCallGateway",
        createEmbeddedCallGateway,
      )
    : openClawToolsDeps.callGateway;
  const coreToolsStartedAtMs = performance.now();
  const tools: AnyAgentTool[] = [
    ...(embedded
      ? []
      : [
          createCanvasTool({ config: options?.config }),
          nodesTool,
          createCronTool({
            agentSessionKey: options?.agentSessionKey,
            currentDeliveryContext: {
              channel: options?.agentChannel,
              to: options?.currentChannelId ?? options?.agentTo,
              accountId: options?.agentAccountId,
              threadId: options?.currentThreadTs ?? options?.agentThreadId,
            },
            ...(options?.cronSelfRemoveOnlyJobId
              ? { selfRemoveOnlyJobId: options.cronSelfRemoveOnlyJobId }
              : {}),
          }),
        ]),
    ...(!embedded && messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: resolvedConfig,
      agentId: sessionAgentId,
      agentAccountId: options?.agentAccountId,
    }),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    ...(embedded
      ? []
      : [
          createGatewayTool({
            agentSessionKey: options?.agentSessionKey,
            config: options?.config,
          }),
        ]),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    ...(isUpdatePlanToolEnabledForOpenClawTools({
      config: resolvedConfig,
      agentSessionKey: options?.agentSessionKey,
      agentId: options?.requesterAgentIdOverride,
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
    })
      ? [createUpdatePlanTool()]
      : []),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    ...(embedded
      ? []
      : [
          createSessionsSendTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            callGateway: openClawToolsDeps.callGateway,
          }),
          createSessionsSpawnTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            agentTo: options?.agentTo,
            agentThreadId: options?.agentThreadId,
            agentGroupId: options?.agentGroupId,
            agentGroupChannel: options?.agentGroupChannel,
            agentGroupSpace: options?.agentGroupSpace,
            agentMemberRoleIds: options?.agentMemberRoleIds,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            requesterAgentIdOverride: options?.requesterAgentIdOverride,
            workspaceDir: spawnWorkspaceDir,
          }),
        ]),
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    ...collectPresentOpenClawTools([webSearchTool, webFetchTool, imageTool, pdfTool]),
  ];
  const coreToolsDurationMs = performance.now() - coreToolsStartedAtMs;

  if (options?.disablePluginTools) {
    return tools;
  }

  const pluginToolsStartedAtMs = performance.now();
  const wrappedPluginTools = resolveOpenClawPluginToolsForOptions({
    options,
    resolvedConfig,
    existingToolNames: new Set(tools.map((tool) => tool.name)),
  });
  const pluginToolsDurationMs = performance.now() - pluginToolsStartedAtMs;
  const totalDurationMs = performance.now() - startedAtMs;
  const preludeDurationMs = Math.max(
    0,
    totalDurationMs - coreToolsDurationMs - pluginToolsDurationMs,
  );
  if (totalDurationMs >= 1_000 || pluginToolsDurationMs >= 1_000) {
    openClawToolsDiagLog.warn(
      `[openclaw-tools-diag] totalMs=${Math.round(totalDurationMs)} preludeMs=${Math.round(
        preludeDurationMs,
      )} coreToolsMs=${Math.round(
        coreToolsDurationMs,
      )} pluginToolsMs=${Math.round(pluginToolsDurationMs)} preludeSegments=${formatTimingSegments(
        preludeSegments,
      )} coreCount=${tools.length} pluginCount=${wrappedPluginTools.length}`,
    );
  }

  return [...tools, ...wrappedPluginTools];
}

export const __testing = {
  setDepsForTest(overrides?: Partial<OpenClawToolsDeps>) {
    openClawToolsDeps = overrides
      ? {
          ...defaultOpenClawToolsDeps,
          ...overrides,
        }
      : defaultOpenClawToolsDeps;
  },
};
