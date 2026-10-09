import { runOpenCodePrompt } from "@lmms-lab/workbench/agents";
import { useCallback, useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { getReadableErrorMessage } from "@/lib/errors";
import {
  AI_COMMIT_DIFF_LIMIT,
  AI_COMMIT_TIMEOUT_MS,
  buildAiCommitPrompt,
  sanitizeAiCommitMessage,
} from "@/lib/git/ai-commit-message";
import { i18n } from "@/lib/i18n";
import type { OpenCodeStatus } from "@/lib/opencode/use-opencode-daemon";
import type { useTauriDaemon } from "@/lib/tauri";

/** State and actions behind the Git sidebar and the GitHub publish dialog. */
export function useGitActions({
  daemon,
  flush,
  ensureOpenCode,
}: {
  daemon: ReturnType<typeof useTauriDaemon>;
  /** Writes pending editor saves first; `false` cancels the action. */
  flush: () => Promise<boolean>;
  ensureOpenCode: (directory: string) => Promise<OpenCodeStatus | null>;
}) {
  const { toast } = useToast();
  const [commitMessage, setCommitMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [showRemoteInput, setShowRemoteInput] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const changes = daemon.gitStatus?.changes;
  const staged = useMemo(() => (changes ?? []).filter((c) => c.staged), [changes]);
  const unstaged = useMemo(() => (changes ?? []).filter((c) => !c.staged), [changes]);

  // Staging and pulling read or rewrite files on disk, so unsaved editor text goes first.
  const stage = useCallback(
    async (paths: string[]) => {
      if (paths.length && (await flush())) await daemon.gitAdd(paths);
    },
    [daemon, flush],
  );
  const unstage = useCallback(
    async (paths: string[]) => {
      if (paths.length) await daemon.gitUnstage(paths);
    },
    [daemon],
  );
  const report = useCallback(
    (result: { success: boolean; error?: string }, done: string, failed: string) =>
      result.success ? toast(done, "success") : toast(result.error || failed, "error"),
    [toast],
  );
  const push = useCallback(async () => {
    report(await daemon.gitPush(), "Changes pushed successfully", "Failed to push changes");
  }, [daemon, report]);
  const pull = useCallback(async () => {
    if (!(await flush())) return;
    report(await daemon.gitPull(), "Changes pulled successfully", "Failed to pull changes");
  }, [daemon, flush, report]);
  const discardAll = useCallback(async () => {
    if (!(await flush())) return;
    report(await daemon.gitDiscardAll(), "All changes discarded", "Failed to discard changes");
  }, [daemon, flush, report]);
  const discardFile = useCallback(
    async (path: string) => {
      if (!(await flush())) return;
      report(
        await daemon.gitDiscardFile(path),
        `Discarded changes: ${path}`,
        "Failed to discard file",
      );
    },
    [daemon, flush, report],
  );
  const submitRemote = useCallback(() => {
    const url = remoteUrl.trim();
    if (!url) return;
    void daemon.gitAddRemote(url);
    setRemoteUrl("");
    setShowRemoteInput(false);
  }, [daemon, remoteUrl]);

  const commit = useCallback(async () => {
    const message = commitMessage.trim();
    if (!message) return;
    const result = await daemon.gitCommit(message);
    if (result.success) {
      toast(i18n.t("msg.changesCommitted"), "success");
      setCommitMessage("");
    } else toast(result.error || i18n.t("msg.failedToCommit"), "error");
  }, [commitMessage, daemon, toast]);

  const generateCommitMessage = useCallback(async () => {
    const directory = daemon.projectPath;
    if (!directory) {
      toast(i18n.t("msg.pleaseOpenAProjectFirst"), "error");
      return;
    }
    if (!staged.length) {
      toast(i18n.t("msg.stageFilesBeforeGeneratingCommitMessage"), "error");
      return;
    }
    setGenerating(true);
    try {
      const ready = await ensureOpenCode(directory);
      if (!ready) {
        toast(i18n.t("msg.opencodeIsUnavailableInstallItWithNpmIGO"), "error");
        return;
      }
      const diff = (await Promise.all(staged.map((c) => daemon.gitDiff(c.path, true))))
        .filter((chunk) => chunk.trim())
        .join("\n\n")
        .slice(0, AI_COMMIT_DIFF_LIMIT)
        .trim();
      if (!diff) {
        toast(i18n.t("msg.noTextualStagedDiffAvailable"), "error");
        return;
      }
      const message = sanitizeAiCommitMessage(
        await runOpenCodePrompt({
          port: ready.port,
          directory,
          prompt: buildAiCommitPrompt(diff, "staged"),
          timeoutMs: AI_COMMIT_TIMEOUT_MS,
        }),
      );
      if (!message) {
        toast(i18n.t("msg.aiReturnedAnEmptyCommitMessage"), "error");
        return;
      }
      setCommitMessage(message);
      toast(i18n.t("msg.aiCommitDraftGenerated"), "success");
    } catch (error) {
      const message = getReadableErrorMessage(
        error,
        i18n.t("msg.couldNotReachOpencodeStartOrRestartTheAg"),
      );
      console.error(`Failed to generate AI commit message: ${message}`);
      toast(i18n.t("msg.aiDraftFailedError", { error: message }), "error");
    } finally {
      setGenerating(false);
    }
  }, [daemon, staged, ensureOpenCode, toast]);

  const startPublish = useCallback(async () => {
    setPublishError(null);
    const status = await daemon.ghCheck();
    if (!status.installed) {
      toast(i18n.t("msg.githubCliGhIsNotInstalledInstallItFromHt"), "error");
      return;
    }
    if (!status.authenticated) {
      if (daemon.isAuthenticatingGh) {
        toast(i18n.t("msg.githubAuthenticationIsAlreadyInProgressI"), "info");
        return;
      }
      toast(i18n.t("msg.terminalOpenedForGithubLoginCompleteProm"), "info");
      const login = await daemon.ghAuthLogin();
      if (!login.success || !login.authenticated) {
        toast(login.error || i18n.t("msg.githubAuthenticationFailed"), "error");
        return;
      }
      toast(i18n.t("msg.authenticatedWithGithub"), "success");
    }
    setPublishOpen(true);
  }, [daemon, toast]);
  const publish = useCallback(
    async (name: string, isPrivate: boolean, description: string) => {
      setPublishError(null);
      const result = await daemon.ghCreateRepo(name, isPrivate, description || undefined);
      if (result.success) {
        setPublishOpen(false);
        toast(i18n.t("msg.repositoryPublishedUrl", { url: result.url ?? "" }), "success");
      } else setPublishError(result.error || i18n.t("msg.failedToCreateRepository"));
    },
    [daemon, toast],
  );
  const cancelPublish = useCallback(() => {
    setPublishOpen(false);
    setPublishError(null);
  }, []);

  return {
    publish: { open: publishOpen, error: publishError, submit: publish, cancel: cancelPublish },
    /** Props for GitSidebarPanel that this hook owns. */
    panel: {
      stagedChanges: staged,
      unstagedChanges: unstaged,
      showRemoteInput,
      remoteUrl,
      onRemoteUrlChange: setRemoteUrl,
      onShowRemoteInput: () => setShowRemoteInput(true),
      onHideRemoteInput: () => setShowRemoteInput(false),
      onSubmitRemote: submitRemote,
      onRefreshStatus: () => void daemon.refreshGitStatus(true),
      onStageAll: () => void stage(unstaged.map((c) => c.path)),
      onStageFile: (path: string) => void stage([path]),
      onUnstageAll: () => void unstage(staged.map((c) => c.path)),
      onUnstageFile: (path: string) => void unstage([path]),
      onDiscardAll: discardAll,
      onDiscardFile: discardFile,
      commitMessage,
      onCommitMessageChange: setCommitMessage,
      onCommit: () => void commit(),
      onPush: push,
      onPull: pull,
      onGenerateCommitMessageAI: generateCommitMessage,
      onPublishToGitHub: () => void startPublish(),
      isGeneratingCommitMessageAI: generating,
    },
  };
}
