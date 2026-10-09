"use client";

import { useState } from "react";
import { useWorkbenchI18n as useI18n } from "../../i18n";
import { Spinner } from "../../ui/spinner";
import { CheckIcon, FolderIcon, TerminalIcon } from "./icons";
import type { OpenCodeDaemonStatus } from "./panel-types";

export function OnboardingState({
  connecting,
  error,
  onConnect,
  daemonStatus,
  onRestartOpenCode,
  hasProject,
}: {
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
  daemonStatus?: OpenCodeDaemonStatus;
  onRestartOpenCode?: () => void;
  hasProject?: boolean;
}) {
  const { t } = useI18n();
  const [copiedNpm, setCopiedNpm] = useState(false);
  const [copiedBrew, setCopiedBrew] = useState(false);

  const copyToClipboard = async (text: string, type: "npm" | "brew") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "npm") {
        setCopiedNpm(true);
        setTimeout(() => setCopiedNpm(false), 2000);
      } else {
        setCopiedBrew(true);
        setTimeout(() => setCopiedBrew(false), 2000);
      }
    } catch {
      // Silently ignore clipboard errors
    }
  };

  if (!hasProject) {
    return (
      <div className="flex-1 flex flex-col p-4 overflow-y-auto">
        <div className="flex-1 flex flex-col justify-center max-w-xs mx-auto w-full space-y-6">
          <div className="text-center">
            <div className="size-12 mx-auto mb-3 border border-border flex items-center justify-center">
              <FolderIcon className="size-6 text-muted" />
            </div>
            <h3 className="text-sm mb-1">{t("opencode.openAProject")}</h3>
            <p className="text-xs text-muted">
              {t("opencode.openALatexProjectFolderToUseAiFeatures")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const steps = [
    {
      id: "install",
      label: t("opencode.installOpencode"),
      status: daemonStatus === "unavailable" ? "current" : daemonStatus ? "complete" : "pending",
    },
    {
      id: "start",
      label: t("opencode.startOpencode"),
      status:
        daemonStatus === "unavailable"
          ? "pending"
          : daemonStatus === "stopped"
            ? "current"
            : daemonStatus === "starting"
              ? "loading"
              : daemonStatus === "running"
                ? "complete"
                : "pending",
    },
    {
      id: "connect",
      label: t("opencode.connect"),
      status: daemonStatus === "running" ? (connecting ? "loading" : "current") : "pending",
    },
  ];

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto">
      <div className="flex-1 flex flex-col justify-center max-w-xs mx-auto w-full space-y-6">
        <div className="text-center">
          <div className="size-12 mx-auto mb-3 border border-border flex items-center justify-center">
            <TerminalIcon className="size-6 text-muted" />
          </div>
          <h3 className="text-sm mb-1">{t("opencode.setupAgentMode")}</h3>
          <p className="text-xs text-muted">{t("opencode.connectToOpencodeToUseAiFeatures")}</p>
        </div>

        <div className="space-y-2">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center gap-3">
              <div
                className={`size-5 flex items-center justify-center text-xs border ${step.status === "complete" ? "border-foreground bg-background" : step.status === "current" || step.status === "loading" ? "border-foreground" : "border-border text-muted"}`}
              >
                {step.status === "complete" ? (
                  <CheckIcon className="size-3" />
                ) : step.status === "loading" ? (
                  <Spinner className="size-3" />
                ) : (
                  index + 1
                )}
              </div>
              <span
                className={`text-xs ${step.status === "complete" ? "text-muted line-through" : step.status === "current" || step.status === "loading" ? "text-foreground" : "text-muted"}`}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>

        {error && (
          <div className="p-2 border border-red-200 bg-red-50 text-xs text-red-600">{error}</div>
        )}

        {daemonStatus === "unavailable" && (
          <div className="space-y-3">
            <p className="text-xs text-muted">{t("opencode.chooseAnInstallationMethod")}</p>
            <div className="space-y-2">
              <div className="border border-border p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted">npm</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard("npm i -g opencode-ai@latest", "npm")}
                    className="text-xs text-muted hover:text-foreground"
                  >
                    {copiedNpm ? t("opencode.copied") : "Copy"}
                  </button>
                </div>
                <code className="text-xs block font-mono">npm i -g opencode-ai@latest</code>
              </div>
              <div className="border border-border p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted">Homebrew</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard("brew install sst/tap/opencode", "brew")}
                    className="text-xs text-muted hover:text-foreground"
                  >
                    {copiedBrew ? t("opencode.copied") : "Copy"}
                  </button>
                </div>
                <code className="text-xs block font-mono">brew install sst/tap/opencode</code>
              </div>
            </div>
            {onRestartOpenCode && (
              <button type="button" onClick={onRestartOpenCode} className="btn-brutalist w-full">
                {t("opencode.iVeInstalledOpencode")}
              </button>
            )}
          </div>
        )}

        {daemonStatus === "stopped" && onRestartOpenCode && (
          <button type="button" onClick={onRestartOpenCode} className="btn-brutalist w-full">
            {t("opencode.startOpencode")}
          </button>
        )}

        {daemonStatus === "starting" && (
          <div className="flex items-center justify-center gap-2 text-xs text-muted py-2">
            <Spinner className="size-4" />
            <span>{t("opencode.startingOpencode")}</span>
          </div>
        )}

        {daemonStatus === "running" && (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="btn-brutalist w-full disabled:opacity-50"
          >
            {connecting ? (
              <>
                <Spinner className="size-4" /> {t("opencode.connecting")}
              </>
            ) : (
              t("opencode.connectToOpencode")
            )}
          </button>
        )}
      </div>
    </div>
  );
}
