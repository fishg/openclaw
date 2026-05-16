import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEvidence,
  resolveProviderAuthEnvVarCandidates,
} from "../secrets/provider-env-vars.js";
import type {
  ProviderAuthEvidence,
  ProviderEnvVarLookupParams,
} from "../secrets/provider-env-vars.js";

export function resolveProviderEnvApiKeyCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates(params);
}

export function resolveProviderEnvAuthEvidence(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly ProviderAuthEvidence[]> {
  return resolveProviderAuthEvidence(params);
}

export function listProviderEnvAuthLookupKeys(params: {
  envCandidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
}): string[] {
  return Array.from(
    new Set([...Object.keys(params.envCandidateMap), ...Object.keys(params.authEvidenceMap)]),
  ).toSorted((a, b) => a.localeCompare(b));
}

export function resolveProviderEnvAuthLookupKeys(params?: ProviderEnvVarLookupParams): string[] {
  return listProviderEnvAuthLookupKeys({
    envCandidateMap: resolveProviderEnvApiKeyCandidates(params),
    authEvidenceMap: resolveProviderEnvAuthEvidence(params),
  });
}

let _providerEnvApiKeyCandidates: Record<string, readonly string[]> | undefined;
export const PROVIDER_ENV_API_KEY_CANDIDATES: Record<string, readonly string[]> = new Proxy(
  {} as Record<string, readonly string[]>,
  {
    get(_, key: string | symbol) {
      _providerEnvApiKeyCandidates ??= resolveProviderEnvApiKeyCandidates();
      return (_providerEnvApiKeyCandidates as Record<string | symbol, unknown>)[key];
    },
    ownKeys() {
      _providerEnvApiKeyCandidates ??= resolveProviderEnvApiKeyCandidates();
      return Reflect.ownKeys(_providerEnvApiKeyCandidates);
    },
    getOwnPropertyDescriptor(_, key: string | symbol) {
      _providerEnvApiKeyCandidates ??= resolveProviderEnvApiKeyCandidates();
      return Object.getOwnPropertyDescriptor(_providerEnvApiKeyCandidates, key);
    },
  },
);

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
