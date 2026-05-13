import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearPdfToolModelConfigCacheForTest,
  resolvePdfModelConfigForTool,
} from "./pdf-tool.model-config.js";
import { resetPdfToolAuthEnv } from "./pdf-tool.test-support.js";

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-7";
const TEST_AGENT_DIR = "/tmp/openclaw-pdf-model-config";
const hoisted = vi.hoisted(() => ({
  hasAuthForProviderMock: vi.fn(
    ({
      provider,
      authStore,
    }: {
      provider: string;
      authStore?: { profiles?: Record<string, { provider: string }> };
    }) => {
      const hasStoreProvider = Object.values(authStore?.profiles ?? {}).some(
        (profile) => profile.provider === provider,
      );
      if (hasStoreProvider) {
        return true;
      }
      if (provider === "anthropic") {
        return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN);
      }
      if (provider === "openai") {
        return Boolean(process.env.OPENAI_API_KEY);
      }
      if (provider === "google") {
        return Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
      }
      return false;
    },
  ),
}));

vi.mock("./model-config.helpers.js", () => ({
  coerceToolModelConfig: (model?: unknown) => {
    if (typeof model === "string") {
      const primary = model.trim();
      return primary ? { primary } : {};
    }
    const objectModel = model as { primary?: string; fallbacks?: string[] } | undefined;
    return {
      ...(objectModel?.primary?.trim() ? { primary: objectModel.primary.trim() } : {}),
      ...(objectModel?.fallbacks?.length ? { fallbacks: objectModel.fallbacks } : {}),
    };
  },
  hasAuthForProvider: hoisted.hasAuthForProviderMock,
  resolveDefaultModelRef: (cfg?: OpenClawConfig) => {
    const modelCfg = cfg?.agents?.defaults?.model;
    const primary =
      (typeof modelCfg === "string"
        ? modelCfg
        : (modelCfg as { primary?: string } | undefined)?.primary) ?? "anthropic/claude-sonnet-4-5";
    const [provider = "anthropic", model = "claude-sonnet-4-5"] = primary.split("/", 2);
    return { provider, model };
  },
}));

function withDefaultModel(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary } } },
  } as OpenClawConfig;
}

describe("resolvePdfModelConfigForTool", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    hoisted.hasAuthForProviderMock.mockClear();
    clearPdfToolModelConfigCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearPdfToolModelConfigCacheForTest();
  });

  it("returns null without any auth", () => {
    const cfg = withDefaultModel("openai/gpt-5.4");
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toBeNull();
  });

  it("prefers explicit pdfModel config", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          pdfModel: { primary: ANTHROPIC_PDF_MODEL },
        },
      },
    } as OpenClawConfig;
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: ANTHROPIC_PDF_MODEL,
    });
  });

  it("falls back to imageModel config when no pdfModel set", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          imageModel: { primary: "openai/gpt-5.4-mini" },
        },
      },
    } as OpenClawConfig;
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "openai/gpt-5.4-mini",
    });
  });

  it("prefers anthropic when available for native PDF support", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg = withDefaultModel("openai/gpt-5.4");
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
  });

  it("uses anthropic primary when provider is anthropic", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
  });

  it("reuses the cached model config result for identical inputs", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg = withDefaultModel("openai/gpt-5.4");

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
    const firstCallCount = hoisted.hasAuthForProviderMock.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
    expect(hoisted.hasAuthForProviderMock.mock.calls.length).toBe(firstCallCount);
  });

  it("reuses the cached result when authStore is unchanged even if auth file mtime changes", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pdf-model-authstore-"));
    fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), JSON.stringify({ profiles: {} }));
    const authStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
    } as const;
    const cfg = withDefaultModel("openai/gpt-5.4");

    expect(
      resolvePdfModelConfigForTool({
        cfg,
        agentDir,
        authStore: authStore as never,
      })?.primary,
    ).toBe("openai/gpt-5.4-mini");
    const firstCallCount = hoisted.hasAuthForProviderMock.mock.calls.length;

    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({ profiles: { touched: true } }),
    );

    expect(
      resolvePdfModelConfigForTool({
        cfg,
        agentDir,
        authStore: authStore as never,
      })?.primary,
    ).toBe("openai/gpt-5.4-mini");
    expect(hoisted.hasAuthForProviderMock.mock.calls.length).toBe(firstCallCount);

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("does not scan configured providers when generic candidates already exist", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg = {
      agents: { defaults: { model: { primary: "zai/glm-5" } } },
      models: {
        providers: {
          openai: { models: [{ id: "gpt-5.4", input: ["image"] }] },
          "unused-provider": { models: [{ id: "unused-vision", input: ["image"] }] },
        },
      },
    } as OpenClawConfig;

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );

    const providersChecked = new Set(
      hoisted.hasAuthForProviderMock.mock.calls.map(([params]) => String(params.provider)),
    );
    expect(providersChecked.has("unused-provider")).toBe(false);
  });
});
