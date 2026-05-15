import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const normalizeProviderModelIdWithRuntimeMock = vi.fn();
const subsystemInfoMock = vi.fn();
const subsystemWarnMock = vi.fn();

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: subsystemInfoMock,
    warn: subsystemWarnMock,
  }),
}));

describe("resolveDefaultModel", () => {
  it("keeps default-model resolution on the static path", async () => {
    normalizeProviderModelIdWithRuntimeMock.mockReset();
    subsystemInfoMock.mockReset();
    subsystemWarnMock.mockReset();
    normalizeProviderModelIdWithRuntimeMock.mockImplementation(({ provider, context }) => {
      if (
        provider === "custom-provider" &&
        (context as { modelId?: string }).modelId === "custom-legacy-model"
      ) {
        return "custom-modern-model";
      }
      return undefined;
    });

    const { resolveDefaultModel } = await import("./directive-handling.defaults.js");

    const result = resolveDefaultModel({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "custom-provider/custom-legacy-model" },
          },
        },
      } as OpenClawConfig,
    });

    expect(result.defaultProvider).toBe("custom-provider");
    expect(result.defaultModel).toBe("custom-legacy-model");
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("caches default-model resolution and returns isolated alias indexes", async () => {
    normalizeProviderModelIdWithRuntimeMock.mockReset();
    subsystemInfoMock.mockReset();
    subsystemWarnMock.mockReset();

    const { resolveDefaultModel } = await import("./directive-handling.defaults.js");
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/gpt-5.4": { alias: "main" },
          },
        },
      },
    } as OpenClawConfig;

    const first = resolveDefaultModel({ cfg, agentId: "cto" });
    first.aliasIndex.byAlias.clear();
    const second = resolveDefaultModel({ cfg, agentId: "cto" });

    expect(second.aliasIndex.byAlias.get("main")?.ref).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    const logCalls = [...subsystemInfoMock.mock.calls, ...subsystemWarnMock.mock.calls];
    expect(
      logCalls.some((call) => String(call[0]).includes("outcome=miss")),
    ).toBe(true);
    expect(
      logCalls.some((call) => String(call[0]).includes("outcome=hit")),
    ).toBe(true);
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });
});
