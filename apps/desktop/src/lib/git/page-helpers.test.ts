import { describe, expect, it } from "vitest";
import { getReadableErrorMessage, getSynctexLookupMessage } from "../errors";
import { extractTextParts } from "../opencode/messages";
import { buildAiCommitPrompt, sanitizeAiCommitMessage } from "./ai-commit-message";
import { parseUnifiedDiffContent } from "./unified-diff";

describe("helpers moved out of the editor page", () => {
  it("rebuilds both sides of a unified diff", () => {
    const diff = parseUnifiedDiffContent(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n\\ No newline at end of file",
    );
    expect(diff).toMatchObject({
      original: "same\nold",
      modified: "same\nnew",
      added: 1,
      removed: 1,
    });
    expect(parseUnifiedDiffContent("Binary files a/x and b/x differ").isBinary).toBe(true);
  });
  it("cleans AI commit messages and builds the prompt", () => {
    expect(sanitizeAiCommitMessage('```\nCommit message: "Fix sync"\n```')).toBe("Fix sync");
    expect(buildAiCommitPrompt("DIFF", "staged")).toContain("staged changes");
  });
  it("reads text parts and explains errors", () => {
    expect(extractTextParts([{ type: "text", text: "a" }, { type: "tool" }])).toEqual(["a"]);
    expect(getReadableErrorMessage(new Error("Failed to fetch"), "offline")).toBe("offline");
    expect(getSynctexLookupMessage("SYNCTEX_FILE_MISSING")).toContain("No SyncTeX data");
  });
});
