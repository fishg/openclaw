import { describe, expect, it, vi } from "vitest";
import { collectPresentOpenClawTools } from "./openclaw-tools.registration.js";
import { createPdfTool } from "./tools/pdf-tool.js";

describe("createOpenClawTools PDF registration", () => {
  it("includes the pdf tool when the pdf factory returns a tool", () => {
    const pdfTool = createPdfTool({
      agentDir: "/tmp/openclaw-agent-main",
      config: {
        agents: {
          defaults: {
            pdfModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
      },
    });

    expect(pdfTool?.name).toBe("pdf");
    expect(collectPresentOpenClawTools([pdfTool]).map((tool) => tool.name)).toEqual(["pdf"]);
  });

  it("passes the logical spawn workspace to the PDF tool", async () => {
    const createPdfToolMock = vi.fn(() => ({
      name: "pdf",
      description: "",
      parameters: {},
      execute: async () => ({ content: [] }),
    }));

    vi.doMock("./tools/pdf-tool.js", async () => {
      const actual =
        await vi.importActual<typeof import("./tools/pdf-tool.js")>("./tools/pdf-tool.js");
      return {
        ...actual,
        createPdfTool: createPdfToolMock,
      };
    });

    const { createOpenClawTools: createOpenClawToolsWithMock } =
      await import("./openclaw-tools.js");
    createOpenClawToolsWithMock({
      agentDir: "/tmp/openclaw-agent-main",
      workspaceDir: "/tmp/sandbox-copy",
      spawnWorkspaceDir: "/tmp/real-workspace",
      authProfileStore: { version: 1, profiles: {} },
      config: {
        agents: {
          defaults: {
            pdfModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
      },
    });

    expect(createPdfToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/real-workspace",
      }),
    );

    vi.doUnmock("./tools/pdf-tool.js");
  });
});
