import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createEmbeddedPiResourceLoader,
  EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
} from "./resource-loader.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createEventBus: vi.fn(() => ({ type: "event-bus" })),
  createExtensionRuntime: vi.fn(() => ({
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    assertActive: vi.fn(),
    invalidate: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    refreshTools: vi.fn(),
    getCommands: vi.fn(() => []),
    setModel: vi.fn(async () => false),
    getThinkingLevel: vi.fn(() => "medium"),
    setThinkingLevel: vi.fn(),
  })),
  loadExtensionFromFactory: vi.fn(async (factory, _cwd, eventBus, _runtime, extensionPath) => {
    await factory({
      on: vi.fn(),
      registerTool: vi.fn(),
      events: eventBus,
    });
    return { path: extensionPath };
  }),
}));

describe("createEmbeddedPiResourceLoader", () => {
  it("keeps discovery options disabled for embedded Pi resource loading", () => {
    expect(EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS).toEqual({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });

  it("loads inline extensions without Pi filesystem discovery", async () => {
    const settingsManager = { reload: vi.fn(async () => undefined) };
    const extensionFactories = [vi.fn()];

    const loader = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: settingsManager as never,
      extensionFactories: extensionFactories as never,
    });

    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getSystemPrompt()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);

    await loader.reload();

    expect(settingsManager.reload).toHaveBeenCalledOnce();
    expect(extensionFactories[0]).toHaveBeenCalledWith(
      expect.objectContaining({
        on: expect.any(Function),
        registerTool: expect.any(Function),
        events: expect.objectContaining({ type: "event-bus" }),
      }),
    );
    expect(createExtensionRuntime).toHaveBeenCalled();
    expect(loader.getExtensions().extensions).toHaveLength(1);
    expect(loader.getExtensions().errors).toEqual([]);
  });
});
