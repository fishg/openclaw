import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { sanitizeForLog, stripAnsi } from "../terminal/ansi.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";
import {
  type ModelRef,
  findNormalizedProviderValue,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  parseModelRef,
} from "./model-selection-normalize.js";

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog(): ReturnType<typeof createSubsystemLogger> {
  log ??= createSubsystemLogger("model-selection");
  return log;
}

const OPENROUTER_COMPAT_FREE_ALIAS = "openrouter:free";

export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
};

type ParsedConfiguredAllowlistEntry = {
  raw: string;
  ref: ModelRef | null;
  key: string | null;
  requiresCatalogInference: boolean;
};

type ConfiguredModelArtifacts = {
  aliasIndex: ModelAliasIndex;
  configuredAllowlistKeys: Set<string> | null;
  parsedAllowlistEntries: ParsedConfiguredAllowlistEntry[];
};

const configuredModelArtifactsCache = new WeakMap<
  OpenClawConfig,
  Map<string, ConfiguredModelArtifacts>
>();
const configuredModelCatalogCache = new WeakMap<OpenClawConfig, ModelCatalogEntry[]>();
const configuredUniqueProviderIndexCache = new WeakMap<
  OpenClawConfig,
  Map<string, string | null>
>();
const resolvedModelRefFromStringCache = new WeakMap<
  OpenClawConfig,
  Map<string, { ref: ModelRef; alias?: string } | null>
>();
const resolvedConfiguredModelRefCache = new WeakMap<OpenClawConfig, Map<string, ModelRef>>();
const modelCatalogMetadataCache = new WeakMap<OpenClawConfig, Map<string, ModelCatalogMetadata>>();
const preparedAllowedCatalogCache = new WeakMap<
  OpenClawConfig,
  WeakMap<readonly ModelCatalogEntry[], Map<string, PreparedAllowedCatalogData>>
>();
type AllowedModelSetResult = {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
};
const buildAllowedModelSetResultCache = new WeakMap<
  OpenClawConfig,
  WeakMap<readonly ModelCatalogEntry[], Map<string, AllowedModelSetResult>>
>();
type ManifestNormalizationContext = {
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};
function sanitizeModelWarningValue(value: string): string {
  const stripped = value ? stripAnsi(value) : "";
  let controlBoundary = -1;
  for (let index = 0; index < stripped.length; index += 1) {
    const code = stripped.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      controlBoundary = index;
      break;
    }
  }
  if (controlBoundary === -1) {
    return sanitizeForLog(stripped);
  }
  return sanitizeForLog(stripped.slice(0, controlBoundary));
}

function mergeModelCatalogEntries(params: {
  primary: readonly ModelCatalogEntry[];
  secondary: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  const merged = [...params.primary];
  const seen = new Set(merged.map((entry) => modelKey(entry.provider, entry.id)));
  for (const entry of params.secondary) {
    const key = modelKey(entry.provider, entry.id);
    if (seen.has(key)) {
      continue;
    }
    merged.push(entry);
    seen.add(key);
  }
  return merged;
}

function catalogLookupKey(provider: string, modelId: string): string {
  return `${normalizeProviderId(provider)}::${normalizeLowercaseStringOrEmpty(modelId)}`;
}

function configuredArtifactsCacheKey(params: {
  defaultProvider: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): string {
  return [
    normalizeProviderId(params.defaultProvider),
    params.allowManifestNormalization === false ? "manifest:off" : "manifest:on",
    params.allowPluginNormalization === false ? "plugin:off" : "plugin:on",
  ].join("|");
}

function cloneModelAliasIndex(index: ModelAliasIndex): ModelAliasIndex {
  return {
    byAlias: new Map(index.byAlias),
    byKey: new Map([...index.byKey.entries()].map(([key, aliases]) => [key, [...aliases]])),
  };
}

function configuredRuntimeCacheKey(params: {
  defaultProvider: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
  raw?: string;
  defaultModel?: string;
  rawModelOverride?: string;
}): string {
  return [
    normalizeProviderId(params.defaultProvider),
    params.allowManifestNormalization === false ? "manifest:off" : "manifest:on",
    params.allowPluginNormalization === false ? "plugin:off" : "plugin:on",
    params.raw?.trim() ?? "",
    params.defaultModel?.trim() ?? "",
    params.rawModelOverride?.trim() ?? "",
  ].join("|");
}

function addUniqueProviderIndexEntry(
  index: Map<string, string | null>,
  modelId: string,
  provider: string,
): void {
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedModelId || !normalizedProvider) {
    return;
  }
  const existing = index.get(normalizedModelId);
  if (existing === undefined) {
    index.set(normalizedModelId, normalizedProvider);
    return;
  }
  if (existing !== normalizedProvider) {
    index.set(normalizedModelId, null);
  }
}

function resolveUniqueProviderFromIndex(
  index: ReadonlyMap<string, string | null>,
  model: string,
): string | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(model.trim());
  if (!normalized) {
    return undefined;
  }
  const provider = index.get(normalized);
  return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}

function resolveConfiguredModelArtifacts(
  params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ConfiguredModelArtifacts {
  if (params.manifestPlugins) {
    return buildConfiguredModelArtifacts(params);
  }
  const cacheKey = configuredArtifactsCacheKey(params);
  const cachedByKey = configuredModelArtifactsCache.get(params.cfg);
  const cached = cachedByKey?.get(cacheKey);
  if (cached) {
    return cached;
  }

  const next = buildConfiguredModelArtifacts(params);
  const nextByKey = cachedByKey ?? new Map<string, ConfiguredModelArtifacts>();
  nextByKey.set(cacheKey, next);
  if (!cachedByKey) {
    configuredModelArtifactsCache.set(params.cfg, nextByKey);
  }
  return next;
}

function buildConfiguredModelArtifacts(
  params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ConfiguredModelArtifacts {
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();
  const rawModels = params.cfg.agents?.defaults?.models ?? {};
  const configuredAllowlistKeys = Object.keys(rawModels).length > 0 ? new Set<string>() : null;
  const parsedAllowlistEntries: ParsedConfiguredAllowlistEntry[] = [];

  for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
    const raw = keyRaw.trim();
    const requiresCatalogInference = !raw.includes("/");
    const parsed = parseModelRefWithCompatAlias({
      cfg: params.cfg,
      raw: keyRaw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    const key = parsed ? modelKey(parsed.provider, parsed.model) : null;
    if (key) {
      configuredAllowlistKeys?.add(key);
    }
    parsedAllowlistEntries.push({
      raw: keyRaw,
      ref: parsed,
      key,
      requiresCatalogInference,
    });
    if (!parsed) {
      continue;
    }
    const alias =
      normalizeOptionalString((entryRaw as { alias?: string } | undefined)?.alias) ?? "";
    if (!alias) {
      continue;
    }
    const aliasKey = normalizeLowercaseStringOrEmpty(alias);
    byAlias.set(aliasKey, { alias, ref: parsed });
    const existing = byKey.get(key ?? "") ?? [];
    existing.push(alias);
    byKey.set(key ?? "", existing);
  }

  return {
    aliasIndex: { byAlias, byKey },
    configuredAllowlistKeys,
    parsedAllowlistEntries,
  };
}

export function inferUniqueProviderFromConfiguredModels(params: {
  cfg: OpenClawConfig;
  model: string;
}): string | undefined {
  const cached = configuredUniqueProviderIndexCache.get(params.cfg);
  if (cached) {
    return resolveUniqueProviderFromIndex(cached, params.model);
  }

  const index = new Map<string, string | null>();
  const configuredModels = params.cfg.agents?.defaults?.models;
  if (configuredModels) {
    for (const key of Object.keys(configuredModels)) {
      const ref = key.trim();
      if (!ref || !ref.includes("/") || ref.endsWith("/*")) {
        continue;
      }
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER, {
        allowPluginNormalization: false,
      });
      if (!parsed) {
        continue;
      }
      addUniqueProviderIndexEntry(index, parsed.model, parsed.provider);
    }
  }
  const configuredProviders = params.cfg.models?.providers;
  if (configuredProviders) {
    for (const [providerId, providerConfig] of Object.entries(configuredProviders)) {
      const models = providerConfig?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const entry of models) {
        const modelId = entry?.id?.trim();
        if (!modelId) {
          continue;
        }
        const normalizedModelId = normalizeConfiguredProviderCatalogModelId(providerId, modelId);
        if (
          normalizedModelId === model ||
          normalizeLowercaseStringOrEmpty(normalizedModelId) === normalized
        ) {
          addProvider(providerId);
        }
      }
      if (providers.size > 1) {
        return undefined;
      }
    }
  }
  configuredUniqueProviderIndexCache.set(params.cfg, index);
  return resolveUniqueProviderFromIndex(index, params.model);
}

export function inferUniqueProviderFromCatalog(params: {
  catalog: readonly ModelCatalogEntry[];
  model: string;
}): string | undefined {
  const model = params.model.trim();
  if (!model) {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(model);
  const providers = new Set<string>();
  for (const entry of params.catalog) {
    const entryId = entry.id.trim();
    if (!entryId) {
      continue;
    }
    if (entryId !== model && normalizeLowercaseStringOrEmpty(entryId) !== normalized) {
      continue;
    }
    const provider = normalizeProviderId(entry.provider);
    if (provider) {
      providers.add(provider);
    }
    if (providers.size > 1) {
      return undefined;
    }
  }
  return providers.size === 1 ? providers.values().next().value : undefined;
}

export function resolveBareModelDefaultProvider(params: {
  cfg: OpenClawConfig;
  catalog: readonly ModelCatalogEntry[];
  model: string;
  defaultProvider: string;
}): string {
  return (
    inferUniqueProviderFromConfiguredModels({ cfg: params.cfg, model: params.model }) ??
    inferUniqueProviderFromCatalog({ catalog: params.catalog, model: params.model }) ??
    params.defaultProvider
  );
}

function isConcreteOpenRouterFreeModelRef(ref: ModelRef): boolean {
  return ref.provider === "openrouter" && ref.model.includes("/") && ref.model.endsWith(":free");
}

function resolveConfiguredOpenRouterCompatFreeRef(
  params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ModelRef | null {
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  for (const raw of Object.keys(configuredModels)) {
    if (!raw.includes("/")) {
      continue;
    }
    const parsed = parseModelRef(raw, params.defaultProvider, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    if (parsed && isConcreteOpenRouterFreeModelRef(parsed)) {
      return parsed;
    }
  }

  const openrouterProviderConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    "openrouter",
  );
  for (const entry of openrouterProviderConfig?.models ?? []) {
    const modelId = entry?.id?.trim();
    if (!modelId || !modelId.includes("/") || !modelId.endsWith(":free")) {
      continue;
    }
    return normalizeModelRef("openrouter", modelId, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  }

  return null;
}

export function resolveConfiguredOpenRouterCompatAlias(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ModelRef | null {
  const normalized = normalizeLowercaseStringOrEmpty(params.raw);
  if (normalized === "openrouter:auto") {
    return normalizeModelRef("openrouter", "auto", {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  }
  if (normalized !== OPENROUTER_COMPAT_FREE_ALIAS || !params.cfg) {
    return null;
  }
  return resolveConfiguredOpenRouterCompatFreeRef({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
}

function parseModelRefWithCompatAlias(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ModelRef | null {
  return (
    resolveConfiguredOpenRouterCompatAlias(params) ??
    resolveExactConfiguredProviderRef(params) ??
    parseModelRef(params.raw, params.defaultProvider, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    })
  );
}

function resolveSlashFormConfiguredAliasMatch(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ModelRef | null {
  const aliasKey = normalizeLowercaseStringOrEmpty(params.raw);
  const rawModels = params.cfg?.agents?.defaults?.models ?? {};
  if (!aliasKey || !params.raw.includes("/") || Object.keys(rawModels).length === 0) {
    return null;
  }
  for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
    const alias =
      normalizeOptionalString((entryRaw as { alias?: string } | undefined)?.alias) ?? "";
    if (!alias || normalizeLowercaseStringOrEmpty(alias) !== aliasKey || !keyRaw.includes("/")) {
      continue;
    }
    return parseModelRefWithCompatAlias({
      cfg: params.cfg,
      raw: keyRaw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
  }
  return null;
}

function resolveExactConfiguredProviderRef(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ModelRef | null {
  const slash = params.raw.indexOf("/");
  if (slash <= 0 || !params.cfg?.models?.providers) {
    return null;
  }
  const providerRaw = params.raw.slice(0, slash).trim();
  const modelRaw = params.raw.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const providerKey = normalizeLowercaseStringOrEmpty(providerRaw);
  const exactConfigured = Object.entries(params.cfg.models.providers).find(
    ([key]) => normalizeLowercaseStringOrEmpty(key) === providerKey,
  );
  if (!exactConfigured) {
    return null;
  }
  const [configuredProvider, providerConfig] = exactConfigured;
  const normalizedConfiguredProvider = normalizeProviderId(configuredProvider);
  const apiOwner =
    typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
  if (!apiOwner || apiOwner === normalizedConfiguredProvider) {
    return null;
  }
  const provider = normalizeLowercaseStringOrEmpty(configuredProvider);
  return {
    provider,
    model: normalizeConfiguredProviderCatalogModelId(
      provider,
      normalizeStaticProviderModelId(provider, modelRaw.trim(), {
        allowManifestNormalization: params.allowManifestNormalization,
        manifestPlugins: params.manifestPlugins,
      }),
    ),
  };
}

export function resolveAllowlistModelKey(params: {
  cfg?: OpenClawConfig;
  raw: string;
  defaultProvider: string;
}): string | null {
  const parsed = parseModelRefWithCompatAlias({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: params.defaultProvider,
  });
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

export function buildConfiguredAllowlistKeys(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
}): Set<string> | null {
  const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
  if (visibility.exactModelRefs.length === 0) {
    return null;
  }

  const keys = new Set<string>();
  for (const raw of visibility.exactModelRefs) {
    const key = resolveAllowlistModelKey({
      cfg: params.cfg,
      raw,
      defaultProvider: params.defaultProvider,
    });
    if (key) {
      keys.add(key);
    }
  }
  return keys.size > 0 ? keys : null;
}

export function buildModelAliasIndex(
  params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): ModelAliasIndex {
  const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
  const byKey = new Map<string, string[]>();

  const rawModels = params.cfg.agents?.defaults?.models ?? {};
  for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
    const trimmedKey = keyRaw.trim();
    if (trimmedKey.endsWith("/*") && normalizeProviderId(trimmedKey.slice(0, -2))) {
      continue;
    }
    const parsed = parseModelRefWithCompatAlias({
      cfg: params.cfg,
      raw: keyRaw,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    if (!parsed) {
      continue;
    }
    const alias =
      normalizeOptionalString((entryRaw as { alias?: string } | undefined)?.alias) ?? "";
    if (!alias) {
      continue;
    }
    const aliasKey = normalizeLowercaseStringOrEmpty(alias);
    byAlias.set(aliasKey, { alias, ref: parsed });
    const key = modelKey(parsed.provider, parsed.model);
    const existing = byKey.get(key) ?? [];
    existing.push(alias);
    byKey.set(key, existing);
  }

  return { byAlias, byKey };
}

type ModelCatalogMetadata = {
  configuredByKey: Map<string, ModelCatalogEntry>;
  aliasByKey: Map<string, string>;
};

type PreparedAllowedCatalogData = {
  metadata: ModelCatalogMetadata;
  catalog: ModelCatalogEntry[];
  catalogByLookupKey: Map<string, ModelCatalogEntry>;
  catalogKeys: Set<string>;
  uniqueProviderByModel: Map<string, string | null>;
};

function buildModelCatalogMetadata(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelCatalogMetadata {
  const cacheKey = configuredRuntimeCacheKey({
    defaultProvider: params.defaultProvider,
  });
  const cachedByKey = modelCatalogMetadataCache.get(params.cfg);
  const cached = cachedByKey?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const artifacts = resolveConfiguredModelArtifacts({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const configuredByKey = new Map<string, ModelCatalogEntry>();
  for (const entry of buildConfiguredModelCatalog({ cfg: params.cfg })) {
    configuredByKey.set(modelKey(entry.provider, entry.id), entry);
  }

  const aliasByKey = new Map<string, string>();
  for (const [key, aliases] of artifacts.aliasIndex.byKey) {
    const alias = aliases[0];
    if (alias) {
      aliasByKey.set(key, alias);
    }
  }

  const next = { configuredByKey, aliasByKey };
  const nextByKey = cachedByKey ?? new Map<string, ModelCatalogMetadata>();
  nextByKey.set(cacheKey, next);
  if (!cachedByKey) {
    modelCatalogMetadataCache.set(params.cfg, nextByKey);
  }
  return next;
}

function buildUniqueProviderByModelIndex(
  catalog: readonly ModelCatalogEntry[],
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const entry of catalog) {
    addUniqueProviderIndexEntry(index, entry.id, entry.provider);
  }
  return index;
}

function prepareAllowedCatalogData(params: {
  cfg: OpenClawConfig;
  catalog: readonly ModelCatalogEntry[];
  defaultProvider: string;
}): PreparedAllowedCatalogData {
  let cachedByCatalog = preparedAllowedCatalogCache.get(params.cfg);
  if (!cachedByCatalog) {
    cachedByCatalog = new WeakMap();
    preparedAllowedCatalogCache.set(params.cfg, cachedByCatalog);
  }
  const cacheKey = configuredRuntimeCacheKey({
    defaultProvider: params.defaultProvider,
  });
  const cachedByKey = cachedByCatalog.get(params.catalog);
  const cached = cachedByKey?.get(cacheKey);
  if (cached) {
    return cached;
  }

  const metadata = buildModelCatalogMetadata({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const configuredCatalog = buildConfiguredModelCatalog({ cfg: params.cfg });
  const catalog = mergeModelCatalogEntries({
    primary: params.catalog,
    secondary: configuredCatalog,
  }).map((entry) => applyModelCatalogMetadata({ entry, metadata }));
  const catalogByLookupKey = new Map<string, ModelCatalogEntry>();
  for (const entry of catalog) {
    const lookupKey = catalogLookupKey(entry.provider, entry.id);
    if (!catalogByLookupKey.has(lookupKey)) {
      catalogByLookupKey.set(lookupKey, entry);
    }
  }
  const next: PreparedAllowedCatalogData = {
    metadata,
    catalog,
    catalogByLookupKey,
    catalogKeys: new Set(catalog.map((entry) => modelKey(entry.provider, entry.id))),
    uniqueProviderByModel: buildUniqueProviderByModelIndex(catalog),
  };
  const nextByKey = cachedByKey ?? new Map<string, PreparedAllowedCatalogData>();
  nextByKey.set(cacheKey, next);
  if (!cachedByKey) {
    cachedByCatalog.set(params.catalog, nextByKey);
  }
  return next;
}

function applyModelCatalogMetadata(params: {
  entry: ModelCatalogEntry;
  metadata: ModelCatalogMetadata;
}): ModelCatalogEntry {
  const key = modelKey(params.entry.provider, params.entry.id);
  const configuredEntry = params.metadata.configuredByKey.get(key);
  const alias = params.metadata.aliasByKey.get(key);
  if (!configuredEntry && !alias) {
    return params.entry;
  }
  const nextAlias = alias ?? params.entry.alias;
  const nextContextWindow = configuredEntry?.contextWindow ?? params.entry.contextWindow;
  const nextContextTokens = configuredEntry?.contextTokens ?? params.entry.contextTokens;
  const nextReasoning = configuredEntry?.reasoning ?? params.entry.reasoning;
  const nextInput = configuredEntry?.input ?? params.entry.input;
  const nextCompat = configuredEntry?.compat ?? params.entry.compat;

  return {
    ...params.entry,
    name: configuredEntry?.name ?? params.entry.name,
    ...(nextAlias ? { alias: nextAlias } : {}),
    ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
    ...(nextContextTokens !== undefined ? { contextTokens: nextContextTokens } : {}),
    ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
    ...(nextInput ? { input: nextInput } : {}),
    ...(nextCompat ? { compat: nextCompat } : {}),
  };
}

function buildSyntheticAllowedCatalogEntry(params: {
  parsed: ModelRef;
  metadata: ModelCatalogMetadata;
}): ModelCatalogEntry {
  const key = modelKey(params.parsed.provider, params.parsed.model);
  const configuredEntry = params.metadata.configuredByKey.get(key);
  const alias = params.metadata.aliasByKey.get(key);
  const nextContextWindow = configuredEntry?.contextWindow;
  const nextContextTokens = configuredEntry?.contextTokens;
  const nextReasoning = configuredEntry?.reasoning;
  const nextInput = configuredEntry?.input;
  const nextCompat = configuredEntry?.compat;

  return {
    id: params.parsed.model,
    name: configuredEntry?.name ?? params.parsed.model,
    provider: params.parsed.provider,
    ...(alias ? { alias } : {}),
    ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
    ...(nextContextTokens !== undefined ? { contextTokens: nextContextTokens } : {}),
    ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
    ...(nextInput ? { input: nextInput } : {}),
    ...(nextCompat ? { compat: nextCompat } : {}),
  };
}

export function resolveModelRefFromString(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): { ref: ModelRef; alias?: string } | null {
  if (params.cfg && !params.manifestPlugins) {
    const cacheKey = configuredRuntimeCacheKey({
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      raw: params.raw,
    });
    let configCache = resolvedModelRefFromStringCache.get(params.cfg);
    if (!configCache) {
      configCache = new Map();
      resolvedModelRefFromStringCache.set(params.cfg, configCache);
    }
    if (configCache.has(cacheKey)) {
      return configCache.get(cacheKey) ?? null;
    }
    const resolved = resolveModelRefFromStringUncached(params);
    configCache.set(cacheKey, resolved);
    return resolved;
  }
  return resolveModelRefFromStringUncached(params);
}

function resolveModelRefFromStringUncached(
  params: {
    cfg?: OpenClawConfig;
    raw: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ManifestNormalizationContext,
): { ref: ModelRef; alias?: string } | null {
  const { model } = splitTrailingAuthProfile(params.raw);
  if (!model) {
    return null;
  }
  const aliasKey = normalizeLowercaseStringOrEmpty(model);
  const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
  if (aliasMatch) {
    return { ref: aliasMatch.ref, alias: aliasMatch.alias };
  }
  const parsed = parseModelRefWithCompatAlias({
    cfg: params.cfg,
    raw: model,
    defaultProvider: params.defaultProvider,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  if (!parsed) {
    return null;
  }
  return { ref: parsed };
}

export function resolveConfiguredModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
  rawModelOverride?: string;
}): ModelRef {
  const cacheKey = configuredRuntimeCacheKey({
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    rawModelOverride: params.rawModelOverride,
  });
  const cachedByKey = resolvedConfiguredModelRefCache.get(params.cfg);
  const cached = cachedByKey?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolved = resolveConfiguredModelRefUncached(params);
  const nextByKey = cachedByKey ?? new Map<string, ModelRef>();
  nextByKey.set(cacheKey, resolved);
  if (!cachedByKey) {
    resolvedConfiguredModelRefCache.set(params.cfg, nextByKey);
  }
  return resolved;
}

function resolveConfiguredModelRefUncached(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
  rawModelOverride?: string;
}): ModelRef {
  const rawModel =
    normalizeOptionalString(params.rawModelOverride) ??
    resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ??
    "";
  if (rawModel) {
    const trimmed = rawModel.trim();
    if (!trimmed.includes("/")) {
      const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
      });
      const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
      const aliasMatch = aliasIndex.byAlias.get(aliasKey);
      if (aliasMatch) {
        return aliasMatch.ref;
      }
      const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
        cfg: params.cfg,
        raw: trimmed,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
      });
      if (openrouterCompatRef) {
        return openrouterCompatRef;
      }

      const inferredProvider = inferUniqueProviderFromConfiguredModels({
        cfg: params.cfg,
        model: trimmed,
      });
      if (inferredProvider) {
        return { provider: inferredProvider, model: trimmed };
      }

      const safeTrimmed = sanitizeModelWarningValue(trimmed);
      const safeResolved = sanitizeForLog(`${params.defaultProvider}/${safeTrimmed}`);
      getLog().warn(
        `Model "${safeTrimmed}" specified without provider. Falling back to "${safeResolved}". Please use "${safeResolved}" in your config.`,
      );
      return { provider: params.defaultProvider, model: trimmed };
    }

    const slashFormAliasMatch = resolveSlashFormConfiguredAliasMatch({
      cfg: params.cfg,
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (slashFormAliasMatch) {
      return slashFormAliasMatch;
    }

    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw: trimmed,
      defaultProvider: params.defaultProvider,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (resolved) {
      return resolved.ref;
    }

    const safe = sanitizeForLog(trimmed);
    const safeFallback = sanitizeForLog(`${params.defaultProvider}/${params.defaultModel}`);
    getLog().warn(
      `Model "${safe}" could not be resolved. Falling back to default "${safeFallback}".`,
    );
  }
  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }
  return { provider: params.defaultProvider, model: params.defaultModel };
}

export function buildAllowedModelSetWithFallbacks(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  fallbackModels: readonly string[];
}): AllowedModelSetResult {
  const resultCacheKey = `${params.defaultProvider}\0${params.defaultModel ?? ""}\0${params.fallbackModels.join("\0")}`;
  let byConfig = buildAllowedModelSetResultCache.get(params.cfg);
  if (!byConfig) {
    byConfig = new WeakMap();
    buildAllowedModelSetResultCache.set(params.cfg, byConfig);
  }
  let byCatalog = byConfig.get(params.catalog);
  if (!byCatalog) {
    byCatalog = new Map();
    byConfig.set(params.catalog, byCatalog);
  }
  const cachedResult = byCatalog.get(resultCacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  const result = buildAllowedModelSetWithFallbacksImpl(params);
  byCatalog.set(resultCacheKey, result);
  return result;
}

function buildAllowedModelSetWithFallbacksImpl(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  fallbackModels: readonly string[];
}): AllowedModelSetResult {
  const prepared = prepareAllowedCatalogData({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
  });
  const configuredCatalog = buildConfiguredModelCatalog({ cfg: params.cfg });
  const catalog = mergeModelCatalogEntries({
    primary: params.catalog,
    secondary: configuredCatalog,
  }).map((entry) => applyModelCatalogMetadata({ entry, metadata }));
  const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
  const allowAny = !visibility.hasEntries;
  const defaultModel = params.defaultModel?.trim();
  const defaultRef =
    defaultModel && params.defaultProvider
      ? parseModelRefWithCompatAlias({
          cfg: params.cfg,
          raw: defaultModel,
          defaultProvider: params.defaultProvider,
        })
      : null;
  const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
  const catalogKeys = new Set<string>();
  for (const entry of catalog) {
    catalogKeys.add(modelKey(entry.provider, entry.id));
  }

  if (allowAny) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: catalog,
      allowedKeys: catalogKeys,
    };
  }

  const allowedKeys = new Set<string>();
  const allowedCatalogLookupKeys = new Set<string>();
  const syntheticCatalogEntries = new Map<string, ModelCatalogEntry>();
  for (const provider of visibility.providerWildcards) {
    allowedKeys.add(providerWildcardModelKey(provider));
  }
  const addAllowedCatalogRef = (ref: ModelRef) => {
    if (
      !allowedRefs.some(
        (existing) =>
          modelKey(existing.provider, existing.model) === modelKey(ref.provider, ref.model),
      )
    ) {
      allowedRefs.push(ref);
    }
  };
  for (const entry of catalog) {
    if (!visibility.providerWildcards.has(normalizeProviderId(entry.provider))) {
      continue;
    }
    allowedKeys.add(modelKey(entry.provider, entry.id));
    addAllowedCatalogRef({ provider: entry.provider, model: entry.id });
  }
  const addAllowedModelRef = (raw: string) => {
    const trimmed = raw.trim();
    const defaultProvider = !trimmed.includes("/")
      ? (resolveUniqueProviderFromIndex(prepared.uniqueProviderByModel, trimmed) ??
        inferUniqueProviderFromConfiguredModels({ cfg: params.cfg, model: trimmed }) ??
        params.defaultProvider)
      : params.defaultProvider;
    const parsed = parseModelRefWithCompatAlias({
      cfg: params.cfg,
      raw,
      defaultProvider,
    });
    if (!parsed) {
      return;
    }
    const key = modelKey(parsed.provider, parsed.model);
    const lookupKey = catalogLookupKey(parsed.provider, parsed.model);
    allowedKeys.add(key);
    allowedCatalogLookupKeys.add(lookupKey);

    if (!catalogByLookupKey.has(lookupKey) && !syntheticCatalogEntries.has(key)) {
      syntheticCatalogEntries.set(key, buildSyntheticAllowedCatalogEntry({ parsed, metadata }));
    }
  };

  for (const raw of visibility.exactModelRefs) {
    addAllowedModelRef(raw);
  }

  if (visibility.exactModelRefs.length > 0) {
    for (const fallback of params.fallbackModels) {
      addAllowedModelRef(fallback);
    }
  }

  if (
    defaultKey &&
    ((visibility.exactModelRefs.length > 0 && visibility.providerWildcards.size === 0) ||
      (defaultRef && visibility.providerWildcards.has(normalizeProviderId(defaultRef.provider))))
  ) {
    allowedKeys.add(defaultKey);
    if (defaultRef) {
      allowedCatalogLookupKeys.add(catalogLookupKey(defaultRef.provider, defaultRef.model));
    }
  }

  const allowedCatalog = [
    ...catalog.filter((entry) =>
      allowedCatalogLookupKeys.has(catalogLookupKey(entry.provider, entry.id)),
    ),
    ...syntheticCatalogEntries.values(),
  ];

  if (
    allowedCatalog.length === 0 &&
    allowedKeys.size === 0 &&
    visibility.providerWildcards.size === 0
  ) {
    if (defaultKey) {
      catalogKeys.add(defaultKey);
    }
    return {
      allowAny: true,
      allowedCatalog: catalog,
      allowedKeys: catalogKeys,
    };
  }

  return { allowAny: false, allowedCatalog, allowedKeys };
}

export type ModelRefStatus = {
  key: string;
  inCatalog: boolean;
  allowAny: boolean;
  allowed: boolean;
};

export type ResolveAllowedModelRefResult =
  | { ref: ModelRef; key: string }
  | {
      error: string;
    };

function getModelRefStatusFromAllowedSet(params: {
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  allowed: {
    allowAny: boolean;
    allowedKeys: Set<string>;
  };
}): ModelRefStatus {
  const key = modelKey(params.ref.provider, params.ref.model);
  return {
    key,
    inCatalog: Boolean(
      findModelCatalogEntry(params.catalog, {
        provider: params.ref.provider,
        modelId: params.ref.model,
      }),
    ),
    allowAny: params.allowed.allowAny,
    allowed: params.allowed.allowAny || isModelKeyAllowedBySet(params.allowed.allowedKeys, key),
  };
}

export function getModelRefStatusWithFallbackModels(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  defaultProvider: string;
  defaultModel?: string;
  fallbackModels: readonly string[];
}): ModelRefStatus {
  const allowed = buildAllowedModelSetWithFallbacks({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    fallbackModels: params.fallbackModels,
  });
  return getModelRefStatusFromAllowedSet({
    catalog: params.catalog,
    ref: params.ref,
    allowed,
  });
}

export function resolveAllowedModelRefFromAliasIndex(params: {
  cfg: OpenClawConfig;
  raw: string;
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
  getStatus: (ref: ModelRef) => ModelRefStatus;
}): ResolveAllowedModelRefResult {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return { error: "invalid model: empty" };
  }

  const effectiveDefaultProvider = !trimmed.includes("/")
    ? (inferUniqueProviderFromConfiguredModels({ cfg: params.cfg, model: trimmed }) ??
      params.defaultProvider)
    : params.defaultProvider;

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: trimmed,
    defaultProvider: effectiveDefaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (!resolved) {
    return { error: `invalid model: ${trimmed}` };
  }

  const status = params.getStatus(resolved.ref);
  if (!status.allowed) {
    return { error: `model not allowed: ${status.key}` };
  }

  return { ref: resolved.ref, key: status.key };
}

export function buildConfiguredModelCatalog(params: { cfg: OpenClawConfig }): ModelCatalogEntry[] {
  const cached = configuredModelCatalogCache.get(params.cfg);
  if (cached) {
    return cached;
  }
  const providers = params.cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const catalog: ModelCatalogEntry[] = [];
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (!providerId || !Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const rawId = normalizeOptionalString(model?.id) ?? "";
      const id = rawId ? normalizeConfiguredProviderCatalogModelId(providerId, rawId) : "";
      if (!id) {
        continue;
      }
      const name = normalizeOptionalString(model?.name) || id;
      const contextWindow =
        typeof model?.contextWindow === "number" && model.contextWindow > 0
          ? model.contextWindow
          : undefined;
      const contextTokens =
        typeof model?.contextTokens === "number" && model.contextTokens > 0
          ? model.contextTokens
          : undefined;
      const reasoning = typeof model?.reasoning === "boolean" ? model.reasoning : undefined;
      const input = Array.isArray(model?.input) ? model.input : undefined;
      const compat = model?.compat && typeof model.compat === "object" ? model.compat : undefined;
      catalog.push({
        provider: providerId,
        id,
        name,
        contextWindow,
        contextTokens,
        reasoning,
        input,
        compat,
      });
    }
  }

  configuredModelCatalogCache.set(params.cfg, catalog);
  return catalog;
}

export function resolveHooksGmailModel(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
}): ModelRef | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel?.trim()) {
    return null;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw: hooksModel,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });

  return resolved?.ref ?? null;
}

export function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

export function parseConfiguredModelVisibilityEntries(params: { cfg?: OpenClawConfig }): {
  exactModelRefs: string[];
  providerWildcards: Set<string>;
  hasEntries: boolean;
} {
  const rawModels = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
  const exactModelRefs: string[] = [];
  const providerWildcards = new Set<string>();

  for (const raw of rawModels) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.endsWith("/*")) {
      const provider = normalizeProviderId(trimmed.slice(0, -2));
      if (provider) {
        providerWildcards.add(provider);
        continue;
      }
    }
    exactModelRefs.push(raw);
  }

  return {
    exactModelRefs,
    providerWildcards,
    hasEntries: rawModels.length > 0,
  };
}

export function providerWildcardModelKey(provider: string): string {
  return modelKey(normalizeProviderId(provider), "*");
}

export function isModelKeyAllowedBySet(allowedKeys: ReadonlySet<string>, key: string): boolean {
  if (allowedKeys.has(key)) {
    return true;
  }
  const separator = key.indexOf("/");
  if (separator <= 0) {
    return false;
  }
  return allowedKeys.has(providerWildcardModelKey(key.slice(0, separator)));
}

export function resolveAllowedModelSelection(params: {
  provider: string;
  model: string;
  allowAny: boolean;
  allowedKeys: ReadonlySet<string>;
  allowedCatalog: readonly ModelCatalogEntry[];
}): ModelRef | null {
  const current = normalizeModelRef(params.provider, params.model);
  if (
    params.allowAny ||
    isModelKeyAllowedBySet(params.allowedKeys, modelKey(current.provider, current.model))
  ) {
    return current;
  }
  const fallback = params.allowedCatalog[0];
  if (!fallback) {
    return null;
  }
  return normalizeModelRef(fallback.provider, fallback.id);
}

export type ModelVisibilityPolicy = {
  allowAny: boolean;
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;
  exactModelRefs: readonly string[];
  providerWildcards: ReadonlySet<string>;
  hasConfiguredEntries: boolean;
  hasProviderWildcards: boolean;
  allowsKey: (key: string) => boolean;
  allows: (ref: { provider: string; model: string }) => boolean;
  resolveSelection: (ref: { provider: string; model: string }) => ModelRef | null;
  visibleCatalog: (params: {
    catalog: readonly ModelCatalogEntry[];
    defaultVisibleCatalog: readonly ModelCatalogEntry[];
    view?: "default" | "configured" | "all";
  }) => ModelCatalogEntry[];
};

function dedupeModelCatalogEntries(entries: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const next: ModelCatalogEntry[] = [];
  for (const entry of entries) {
    const key = modelKey(entry.provider, entry.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(entry);
  }
  return next;
}

export function createModelVisibilityPolicyWithFallbacks(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  fallbackModels: readonly string[];
}): ModelVisibilityPolicy {
  const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
  const allowed = buildAllowedModelSetWithFallbacks(params);
  const allowsKey = (key: string): boolean =>
    allowed.allowAny || isModelKeyAllowedBySet(allowed.allowedKeys, key);
  const exactConfiguredKeys = new Set<string>();
  for (const raw of visibility.exactModelRefs) {
    const key = resolveAllowlistModelKey({
      cfg: params.cfg,
      raw,
      defaultProvider: params.defaultProvider,
    });
    if (key) {
      exactConfiguredKeys.add(key);
    }
  }
  const policy: ModelVisibilityPolicy = {
    allowAny: allowed.allowAny,
    allowedCatalog: allowed.allowedCatalog,
    allowedKeys: allowed.allowedKeys,
    exactModelRefs: visibility.exactModelRefs,
    providerWildcards: visibility.providerWildcards,
    hasConfiguredEntries: visibility.hasEntries,
    hasProviderWildcards: visibility.providerWildcards.size > 0,
    allowsKey,
    allows: (ref) => allowsKey(modelKey(ref.provider, ref.model)),
    resolveSelection: (ref) =>
      resolveAllowedModelSelection({
        provider: ref.provider,
        model: ref.model,
        allowAny: allowed.allowAny,
        allowedKeys: allowed.allowedKeys,
        allowedCatalog: allowed.allowedCatalog,
      }),
    visibleCatalog: ({ catalog, defaultVisibleCatalog, view }) => {
      if (view === "all") {
        return [...catalog];
      }
      if (allowed.allowAny) {
        return [...defaultVisibleCatalog];
      }
      if (visibility.providerWildcards.size === 0) {
        return [...allowed.allowedCatalog];
      }
      return dedupeModelCatalogEntries([
        ...defaultVisibleCatalog.filter((entry) =>
          visibility.providerWildcards.has(normalizeProviderId(entry.provider)),
        ),
        ...allowed.allowedCatalog.filter(
          (entry) =>
            !visibility.providerWildcards.has(normalizeProviderId(entry.provider)) ||
            exactConfiguredKeys.has(modelKey(entry.provider, entry.id)),
        ),
      ]);
    },
  };
  return policy;
}
