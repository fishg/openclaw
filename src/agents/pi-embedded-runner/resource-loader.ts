import {
  createEventBus,
  createExtensionRuntime,
  type EventBus,
  type Extension,
  type ExtensionFactory,
  type ExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

type EmbeddedPiResourceLoaderOptions = {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  extensionFactories?: ExtensionFactory[];
};

type ResourceExtensionPaths = Parameters<ResourceLoader["extendResources"]>[0];
type ExtensionApi = Parameters<ExtensionFactory>[0];
type ExtensionHandlerList =
  Extension["handlers"] extends Map<string, infer Handlers> ? Handlers : never;
type ExtensionHandlerEntry = ExtensionHandlerList extends Array<infer Handler> ? Handler : never;
type ExtensionToolEntry = Extension["tools"] extends Map<string, infer Tool> ? Tool : never;
type ExtensionMessageRendererEntry =
  Extension["messageRenderers"] extends Map<string, infer Renderer> ? Renderer : never;

function createEmptyExtensionsResult(): LoadExtensionsResult {
  return {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
}

function formatExtensionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Failed to load extension: ${message}`;
}

function createInlineExtension(extensionPath: string): Extension {
  return {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: {
      path: extensionPath,
      source: "inline",
      scope: "temporary",
      origin: "top-level",
    },
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function createInlineExtensionApi(params: {
  extension: Extension;
  runtime: ExtensionRuntime;
  eventBus: EventBus;
}): ExtensionApi {
  const { extension, runtime, eventBus } = params;
  return {
    on(event, handler) {
      runtime.assertActive();
      const handlers = extension.handlers.get(event) ?? [];
      handlers.push(handler as ExtensionHandlerEntry);
      extension.handlers.set(event, handlers);
    },
    registerTool(tool) {
      runtime.assertActive();
      extension.tools.set(tool.name, {
        definition: tool,
        sourceInfo: extension.sourceInfo,
      } as ExtensionToolEntry);
      runtime.refreshTools();
    },
    registerCommand(name, options) {
      runtime.assertActive();
      extension.commands.set(name, {
        name,
        sourceInfo: extension.sourceInfo,
        ...options,
      });
    },
    registerShortcut(shortcut, options) {
      runtime.assertActive();
      extension.shortcuts.set(shortcut, {
        shortcut,
        extensionPath: extension.path,
        ...options,
      });
    },
    registerFlag(name, options) {
      runtime.assertActive();
      extension.flags.set(name, {
        name,
        extensionPath: extension.path,
        ...options,
      });
      if (options.default !== undefined && !runtime.flagValues.has(name)) {
        runtime.flagValues.set(name, options.default);
      }
    },
    getFlag(name) {
      runtime.assertActive();
      if (!extension.flags.has(name)) {
        return undefined;
      }
      return runtime.flagValues.get(name);
    },
    registerMessageRenderer(customType, renderer) {
      runtime.assertActive();
      extension.messageRenderers.set(customType, renderer as ExtensionMessageRendererEntry);
    },
    sendMessage(message, options) {
      runtime.assertActive();
      runtime.sendMessage(message, options);
    },
    sendUserMessage(content, options) {
      runtime.assertActive();
      runtime.sendUserMessage(content, options);
    },
    appendEntry(customType, data) {
      runtime.assertActive();
      runtime.appendEntry(customType, data);
    },
    setSessionName(name) {
      runtime.assertActive();
      runtime.setSessionName(name);
    },
    getSessionName() {
      runtime.assertActive();
      return runtime.getSessionName();
    },
    setLabel(entryId, label) {
      runtime.assertActive();
      runtime.setLabel(entryId, label);
    },
    async exec() {
      runtime.assertActive();
      throw new Error("Extension runtime exec is unavailable during embedded resource loading.");
    },
    getActiveTools() {
      runtime.assertActive();
      return runtime.getActiveTools();
    },
    getAllTools() {
      runtime.assertActive();
      return runtime.getAllTools();
    },
    setActiveTools(toolNames) {
      runtime.assertActive();
      runtime.setActiveTools(toolNames);
    },
    getCommands() {
      runtime.assertActive();
      return runtime.getCommands();
    },
    setModel(model) {
      runtime.assertActive();
      return runtime.setModel(model);
    },
    getThinkingLevel() {
      runtime.assertActive();
      return runtime.getThinkingLevel();
    },
    setThinkingLevel(level) {
      runtime.assertActive();
      runtime.setThinkingLevel(level);
    },
    registerProvider(name, config) {
      runtime.assertActive();
      runtime.registerProvider(name, config, extension.path);
    },
    unregisterProvider(name) {
      runtime.assertActive();
      runtime.unregisterProvider(name, extension.path);
    },
    events: eventBus,
  };
}

async function loadInlineExtensionFactory(params: {
  factory: ExtensionFactory;
  cwd: string;
  eventBus: EventBus;
  runtime: ExtensionRuntime;
  extensionPath: string;
}): Promise<Extension> {
  const extension = createInlineExtension(params.extensionPath);
  const api = createInlineExtensionApi({
    extension,
    runtime: params.runtime,
    eventBus: params.eventBus,
  });
  await params.factory(api);
  return extension;
}

class EmbeddedPiResourceLoader implements ResourceLoader {
  #extensionsResult = createEmptyExtensionsResult();

  constructor(private readonly options: EmbeddedPiResourceLoaderOptions) {}

  getExtensions(): LoadExtensionsResult {
    return this.#extensionsResult;
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string | undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  extendResources(_paths: ResourceExtensionPaths): void {}

  async reload(): Promise<void> {
    await this.options.settingsManager.reload();
    const eventBus = createEventBus();
    const runtime = createExtensionRuntime();
    const extensions: LoadExtensionsResult["extensions"] = [];
    const errors: LoadExtensionsResult["errors"] = [];
    const factories = this.options.extensionFactories ?? [];

    for (let index = 0; index < factories.length; index += 1) {
      const extensionPath = `<inline:${index + 1}>`;
      try {
        extensions.push(
          await loadInlineExtensionFactory({
            factory: factories[index],
            cwd: this.options.cwd,
            eventBus,
            runtime,
            extensionPath,
          }),
        );
      } catch (err) {
        errors.push({ path: extensionPath, error: formatExtensionError(err) });
      }
    }

    this.#extensionsResult = {
      extensions,
      errors,
      runtime,
    };
  }
}

export function createEmbeddedPiResourceLoader(
  options: EmbeddedPiResourceLoaderOptions,
): ResourceLoader {
  return new EmbeddedPiResourceLoader(options);
}
