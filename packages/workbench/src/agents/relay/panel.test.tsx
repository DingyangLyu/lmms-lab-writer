import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareChatFiles } from "../chat/files";
import {
  type AgentPlatform,
  AgentPlatformScope,
  agentPlatform,
  setAgentPlatform,
  useAgentPlatform,
  useBridge,
} from "../platform";
import { serverPlatform } from "./panel";

const original = agentPlatform();
afterEach(() => setAgentPlatform(original));

/** The desktop's platform, whose local-folder features must stay out of server panels. */
function desktopLike() {
  const bridge = vi.fn(() => ({ working: false, register: async () => {}, view: null }));
  const platform: AgentPlatform = {
    openExternal: vi.fn(),
    readImagePath: vi.fn(),
    importDocumentPath: vi.fn(),
    importDocumentData: vi.fn(),
    validateDocuments: vi.fn(),
    useBridge: bridge,
    beforeAgentTurn: vi.fn(),
    onConversationUpdated: vi.fn(),
  };
  return { platform, bridge };
}

describe("the server column's platform", () => {
  it("keeps the desktop's bridge, attachment copies and review baseline away", async () => {
    const { platform, bridge } = desktopLike();
    setAgentPlatform(platform);
    let seen: AgentPlatform | null = null;
    function Panel() {
      useBridge("codex", "thread", "server-project-id", "Codex", false, {});
      seen = useAgentPlatform();
      return null;
    }
    renderToStaticMarkup(
      <AgentPlatformScope platform={serverPlatform(agentPlatform())}>
        <Panel />
      </AgentPlatformScope>,
    );
    expect(bridge).not.toHaveBeenCalled();
    const scoped = seen as unknown as AgentPlatform;
    expect(scoped.beforeAgentTurn).toBeUndefined();
    expect(scoped.importDocumentPath).toBeUndefined();
    expect(scoped.readImagePath).toBe(platform.readImagePath);
    // A document attached in the server column is refused, not validated as a local folder.
    await expect(
      prepareChatFiles(
        "server-project-id",
        "read",
        [
          {
            kind: "document",
            url: "",
            filename: "notes.pdf",
            path: "/x/notes.pdf",
            size: 3,
            mime: "application/pdf",
          },
        ],
        scoped,
      ),
    ).rejects.toThrow();
    expect(platform.validateDocuments).not.toHaveBeenCalled();
    // Outside a scope, panels keep the app's platform.
    renderToStaticMarkup(<Panel />);
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});
