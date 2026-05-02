import fs from "node:fs";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import { buildMediaUnderstandingManifestMetadataRegistry } from "../../media-understanding/manifest-metadata.js";
import { resolveAuthStorePath } from "../auth-profiles/path-resolve.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import {
  coerceImageModelConfig,
  type ImageModelConfig,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import { hasAuthForProvider, resolveDefaultModelRef } from "./model-config.helpers.js";
import { coercePdfModelConfig } from "./pdf-tool.helpers.js";

const log = createSubsystemLogger("agents/tools/pdf");
const PDF_MODEL_CONFIG_TRACE_WARN_MS = 500;
const PDF_MODEL_CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type PdfToolModelConfigCacheEntry = {
  value: ImageModelConfig | null;
  expiresAt: number;
};

const pdfToolModelConfigCache = new Map<string, PdfToolModelConfigCacheEntry>();

type ProviderAuthResolver = (providerId: string) => boolean;

function collectSlowestTimings(
  values: Array<{ label: string; durationMs: number }>,
  limit = 8,
): string {
  return values
    .filter((value) => value.durationMs > 0)
    .toSorted(
      (left, right) => right.durationMs - left.durationMs || left.label.localeCompare(right.label),
    )
    .slice(0, limit)
    .map((value) => `${value.label}:${value.durationMs}ms`)
    .join(",");
}

function safeStatFingerprint(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function buildPdfToolModelConfigCacheKey(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
}): string {
  const configKey = params.cfg ? resolveRuntimeConfigCacheKey(params.cfg) : "config:none";
  const requestedAuthPath = resolveAuthStorePath(params.agentDir);
  const mainAuthPath = resolveAuthStorePath();
  const authFingerprintParts = [safeStatFingerprint(requestedAuthPath)];
  if (requestedAuthPath !== mainAuthPath) {
    authFingerprintParts.push(safeStatFingerprint(mainAuthPath));
  }
  return [configKey, `workspace:${params.workspaceDir ?? ""}`, ...authFingerprintParts].join("|");
}

export function clearPdfToolModelConfigCacheForTest(): void {
  pdfToolModelConfigCache.clear();
}

function resolveImageCandidateRefs(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: ReturnType<typeof buildMediaUnderstandingManifestMetadataRegistry>;
  filter?: (providerId: string) => boolean;
  hasProviderAuth: ProviderAuthResolver;
  timingLabel: string;
  providerTimings: Array<{ label: string; durationMs: number }>;
}): string[] {
  return resolveAutoMediaKeyProviders({
    capability: "image",
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    providerRegistry: params.providerRegistry,
  })
    .filter((providerId) => !params.filter || params.filter(providerId))
    .filter((providerId) => {
      const startedAt = Date.now();
      const allowed = params.hasProviderAuth(providerId);
      params.providerTimings.push({
        label: `${params.timingLabel}:auth:${providerId}`,
        durationMs: Date.now() - startedAt,
      });
      return allowed;
    })
    .map((providerId) => {
      const startedAt = Date.now();
      const modelId =
        resolveProviderVisionModelFromConfig({
          cfg: params.cfg,
          provider: providerId,
        })?.split("/")[1] ??
        resolveDefaultMediaModel({
          cfg: params.cfg,
          workspaceDir: params.workspaceDir,
          providerId,
          capability: "image",
          providerRegistry: params.providerRegistry,
        });
      params.providerTimings.push({
        label: `${params.timingLabel}:model:${providerId}`,
        durationMs: Date.now() - startedAt,
      });
      return modelId ? `${providerId}/${modelId}` : null;
    })
    .filter((value): value is string => Boolean(value));
}

export function resolvePdfModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
}): ImageModelConfig | null {
  const startedAt = Date.now();
  const cacheKey = buildPdfToolModelConfigCacheKey({
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  const now = Date.now();
  const cached = pdfToolModelConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value ? { ...cached.value } : null;
  }
  const explicitPdf = coercePdfModelConfig(params.cfg);
  if (explicitPdf.primary?.trim() || (explicitPdf.fallbacks?.length ?? 0) > 0) {
    const resolved = resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicitPdf,
    });
    pdfToolModelConfigCache.set(cacheKey, {
      value: resolved ? { ...resolved } : null,
      expiresAt: now + PDF_MODEL_CONFIG_CACHE_TTL_MS,
    });
    log.warn(
      `[trace:pdf-tool] model-config totalMs=${Date.now() - startedAt} mode=explicit-pdf result=${resolved?.primary ?? "null"}`,
    );
    return resolved;
  }

  const explicitImage = coerceImageModelConfig(params.cfg);
  if (explicitImage.primary?.trim() || (explicitImage.fallbacks?.length ?? 0) > 0) {
    const resolved = resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicitImage,
    });
    pdfToolModelConfigCache.set(cacheKey, {
      value: resolved ? { ...resolved } : null,
      expiresAt: now + PDF_MODEL_CONFIG_CACHE_TTL_MS,
    });
    log.warn(
      `[trace:pdf-tool] model-config totalMs=${Date.now() - startedAt} mode=explicit-image result=${resolved?.primary ?? "null"}`,
    );
    return resolved;
  }

  const timings: string[] = [];
  const providerTimings: Array<{ label: string; durationMs: number }> = [];
  const mark = (label: string, stepStartedAt: number) => {
    timings.push(`${label}:${Date.now() - stepStartedAt}ms`);
  };
  const authCache = new Map<string, boolean>();
  const hasProviderAuth = (providerId: string): boolean => {
    const normalized = providerId.trim();
    if (!normalized) {
      return false;
    }
    const canonical = resolveProviderIdForAuth(normalized, {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    });
    if (!canonical) {
      return false;
    }
    const cached = authCache.get(canonical);
    if (cached !== undefined) {
      return cached;
    }
    const allowed = hasAuthForProvider({
      provider: canonical,
      agentDir: params.agentDir,
      authStore: params.authStore,
    });
    authCache.set(canonical, allowed);
    return allowed;
  };

  const primary = resolveDefaultModelRef(params.cfg);
  const registryStartedAt = Date.now();
  const providerRegistry = buildMediaUnderstandingManifestMetadataRegistry(
    params.cfg,
    params.workspaceDir,
  );
  mark("provider-registry", registryStartedAt);
  const googleAuthStartedAt = Date.now();
  const googleOk = hasProviderAuth("google");
  mark("google-auth", googleAuthStartedAt);

  const fallbacks: string[] = [];
  const addFallback = (ref: string) => {
    const trimmed = ref.trim();
    if (trimmed && !fallbacks.includes(trimmed)) {
      fallbacks.push(trimmed);
    }
  };

  let preferred: string | null = null;

  const primaryAuthStartedAt = Date.now();
  const providerOk = hasProviderAuth(primary.provider);
  mark("primary-auth", primaryAuthStartedAt);
  const providerVisionStartedAt = Date.now();
  const providerVision = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  mark("primary-vision-config", providerVisionStartedAt);
  const providerDefaultStartedAt = Date.now();
  const providerDefault =
    providerVision?.split("/")[1] ??
    resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId: primary.provider,
      capability: "image",
      providerRegistry,
    });
  mark("primary-default-model", providerDefaultStartedAt);
  const primaryNativeStartedAt = Date.now();
  const primarySupportsNativePdf = providerSupportsNativePdfDocument({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    providerId: primary.provider,
    providerRegistry,
  });
  mark("primary-native-check", primaryNativeStartedAt);
  const nativeCandidatesStartedAt = Date.now();
  const nativePdfCandidates = resolveImageCandidateRefs({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    providerRegistry,
    hasProviderAuth,
    timingLabel: "native-candidates",
    providerTimings,
    filter: (providerId) =>
      providerSupportsNativePdfDocument({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
        providerRegistry,
      }),
  });
  mark("native-candidates", nativeCandidatesStartedAt);
  const genericCandidatesStartedAt = Date.now();
  const genericImageCandidates = resolveImageCandidateRefs({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    providerRegistry,
    hasProviderAuth,
    timingLabel: "generic-candidates",
    providerTimings,
  });
  mark("generic-candidates", genericCandidatesStartedAt);

  if (params.cfg?.models?.providers && typeof params.cfg.models.providers === "object") {
    const configuredProvidersStartedAt = Date.now();
    const configuredScanTimings: Array<{ label: string; durationMs: number }> = [];
    for (const [providerKey, providerCfg] of Object.entries(params.cfg.models.providers)) {
      const providerId = providerKey.trim();
      if (!providerId) {
        continue;
      }
      const models = providerCfg?.models ?? [];
      const modelStartedAt = Date.now();
      const modelId = models
        .find(
          (model) =>
            Boolean(model?.id?.trim()) &&
            Array.isArray(model?.input) &&
            model.input.includes("image"),
        )
        ?.id?.trim();
      configuredScanTimings.push({
        label: `configured-provider-scan:model:${providerId}`,
        durationMs: Date.now() - modelStartedAt,
      });
      if (!modelId) {
        continue;
      }
      const authStartedAt = Date.now();
      if (!hasProviderAuth(providerId)) {
        configuredScanTimings.push({
          label: `configured-provider-scan:auth:${providerId}`,
          durationMs: Date.now() - authStartedAt,
        });
        continue;
      }
      configuredScanTimings.push({
        label: `configured-provider-scan:auth:${providerId}`,
        durationMs: Date.now() - authStartedAt,
      });
      const ref = `${providerId}/${modelId}`;
      if (!genericImageCandidates.includes(ref)) {
        genericImageCandidates.push(ref);
      }
    }
    mark("configured-provider-scan", configuredProvidersStartedAt);
    providerTimings.push(...configuredScanTimings);
  }

  const selectStartedAt = Date.now();
  if (primary.provider === "google" && googleOk && providerVision && primarySupportsNativePdf) {
    preferred = providerVision;
  } else if (providerOk && primarySupportsNativePdf && (providerVision || providerDefault)) {
    preferred = providerVision ?? `${primary.provider}/${providerDefault}`;
  } else {
    preferred = nativePdfCandidates[0] ?? genericImageCandidates[0] ?? null;
  }
  mark("select-preferred", selectStartedAt);

  if (preferred?.trim()) {
    const fallbackBuildStartedAt = Date.now();
    for (const candidate of [...nativePdfCandidates, ...genericImageCandidates]) {
      if (candidate !== preferred) {
        addFallback(candidate);
      }
    }
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    mark("build-fallbacks", fallbackBuildStartedAt);
    const result = { primary: preferred, ...(pruned.length > 0 ? { fallbacks: pruned } : {}) };
    const totalMs = Date.now() - startedAt;
    pdfToolModelConfigCache.set(cacheKey, {
      value: { ...result },
      expiresAt: now + PDF_MODEL_CONFIG_CACHE_TTL_MS,
    });
    if (totalMs >= PDF_MODEL_CONFIG_TRACE_WARN_MS) {
      log.warn(
        `[trace:pdf-tool] model-config totalMs=${totalMs} primaryProvider=${primary.provider} primaryOk=${String(providerOk)} googleOk=${String(googleOk)} primaryNative=${String(primarySupportsNativePdf)} nativeCandidates=${nativePdfCandidates.length} genericCandidates=${genericImageCandidates.length} authCacheSize=${authCache.size} chosen=${result.primary} timings=${timings.join(",")} slowProviders=${collectSlowestTimings(providerTimings)}`,
      );
    }
    return result;
  }

  const totalMs = Date.now() - startedAt;
  pdfToolModelConfigCache.set(cacheKey, {
    value: null,
    expiresAt: now + PDF_MODEL_CONFIG_CACHE_TTL_MS,
  });
  if (totalMs >= PDF_MODEL_CONFIG_TRACE_WARN_MS) {
    log.warn(
      `[trace:pdf-tool] model-config totalMs=${totalMs} primaryProvider=${primary.provider} primaryOk=${String(providerOk)} googleOk=${String(googleOk)} primaryNative=${String(primarySupportsNativePdf)} nativeCandidates=${nativePdfCandidates.length} genericCandidates=${genericImageCandidates.length} authCacheSize=${authCache.size} chosen=null timings=${timings.join(",")} slowProviders=${collectSlowestTimings(providerTimings)}`,
    );
  }
  return null;
}
