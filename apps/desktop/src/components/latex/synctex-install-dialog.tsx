"use client";

import { ArrowClockwiseIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/lib/i18n";
import { useLatexInstaller } from "@/lib/latex";

type QuickInstallStatus = "idle" | "checking" | "installing" | "success" | "error" | "no_texdist";

interface SynctexInstallDialogProps {
  open: boolean;
  onClose: () => void;
  onInstallComplete: () => void;
}

export function SynctexInstallDialog({
  open,
  onClose,
  onInstallComplete,
}: SynctexInstallDialogProps) {
  const { t } = useI18n();
  // Quick install state (tlmgr install synctex)
  const [quickStatus, setQuickStatus] = useState<QuickInstallStatus>("idle");
  const [quickError, setQuickError] = useState<string | null>(null);

  // Full distribution install (fallback)
  const {
    distributions,
    progress,
    result,
    fetchDistributions,
    install,
    openDownloadPage,
    reset: resetInstaller,
    isInstalling,
  } = useLatexInstaller();

  const showFullInstaller = quickStatus === "no_texdist";

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) return;
    setQuickStatus("idle");
    setQuickError(null);
    resetInstaller();
  }, [open, resetInstaller]);

  // User-triggered quick install via tlmgr
  const handleQuickInstall = useCallback(async () => {
    setQuickStatus("checking");
    try {
      const hasTexDist = await invoke<boolean>("latex_install_synctex");
      if (hasTexDist) {
        setQuickStatus("success");
      } else {
        // No TeX distribution found, fall back to full installer
        setQuickStatus("no_texdist");
        fetchDistributions();
      }
    } catch (err) {
      setQuickError(String(err));
      setQuickStatus("error");
    }
  }, [fetchDistributions]);

  const handleRetryQuick = useCallback(() => {
    setQuickStatus("idle");
    setQuickError(null);
  }, []);

  const handleRetry = useCallback(() => {
    resetInstaller();
    onInstallComplete();
  }, [resetInstaller, onInstallComplete]);

  const handleClose = useCallback(() => {
    setQuickStatus("idle");
    setQuickError(null);
    resetInstaller();
    onClose();
  }, [resetInstaller, onClose]);

  const handleInstall = async (distributionId: string) => {
    await install(distributionId);
  };

  const handleOpenDownload = (url: string) => {
    openDownloadPage(url);
  };

  const isBusy = quickStatus === "checking" || quickStatus === "installing" || isInstalling;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-foreground/50 z-[9999]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] bg-background border-2 border-foreground shadow-[4px_4px_0_0_var(--foreground)] w-full max-w-md max-h-[85vh] overflow-hidden flex flex-col"
          onPointerDownOutside={(e) => {
            if (isBusy) e.preventDefault();
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <WarningIcon className="size-5 text-amber-600" />
              <Dialog.Title className="text-base font-bold tracking-tight">
                {t("latex.synctexNotAvailable")}
              </Dialog.Title>
            </div>
            {!isBusy && (
              <Dialog.Close
                className="p-1.5 hover:bg-accent-hover transition-colors border border-transparent hover:border-border"
                aria-label={t("latex.close")}
              >
                <XIcon className="size-4" />
              </Dialog.Close>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <p className="text-sm text-foreground-secondary leading-relaxed">
              {t("latex.synctexIsRequiredForPdfToSourceNavigatio")}
            </p>

            <AnimatePresence mode="wait">
              {/* Idle: waiting for user confirmation */}
              {quickStatus === "idle" && (
                <motion.div
                  key="quick-idle"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-4"
                >
                  <button
                    type="button"
                    onClick={handleQuickInstall}
                    className="btn btn-sm border-2 border-green-600 bg-green-600 text-white shadow-[2px_2px_0_0_#22c55e] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all"
                  >
                    {t("latex.installSynctex")}
                  </button>
                  <p className="text-xs text-muted mt-2">
                    {t("latex.willRun")}{" "}
                    <code className="bg-accent-hover px-1 py-0.5">tlmgr install synctex</code>{" "}
                    {t("latex.toInstallTheMissingPackage")}
                  </p>
                </motion.div>
              )}

              {/* Quick install: checking / installing */}
              {(quickStatus === "checking" || quickStatus === "installing") && (
                <motion.div
                  key="quick-progress"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-4 p-3 bg-surface-secondary border border-amber-300"
                >
                  <div className="flex items-center gap-2">
                    <Spinner className="size-4" />
                    <span className="text-sm font-medium">
                      {quickStatus === "checking"
                        ? t("latex.installingSynctexViaTlmgr")
                        : t("latex.installing")}
                    </span>
                  </div>
                  <p className="text-sm text-muted mt-1">
                    {t("latex.running")}{" "}
                    <code className="text-xs bg-accent-hover px-1 py-0.5">
                      tlmgr install synctex
                    </code>
                  </p>
                </motion.div>
              )}

              {/* Quick install: success */}
              {quickStatus === "success" && (
                <motion.div
                  key="quick-success"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-4 p-3 bg-green-50 border border-green-300"
                >
                  <p className="text-sm text-green-700">
                    {t("latex.synctexInstalledSuccessfully")}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleRetry}
                      className="btn btn-sm border-2 border-green-600 bg-green-600 text-white hover:bg-green-700 transition-colors"
                    >
                      {t("latex.retrySynctex")}
                    </button>
                    <span className="text-xs text-green-600">
                      {t("latex.clickToNavigateToSource")}
                    </span>
                  </div>
                </motion.div>
              )}

              {/* Quick install: error (tlmgr failed) */}
              {quickStatus === "error" && (
                <motion.div
                  key="quick-error"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-4 p-3 bg-background border border-amber-300"
                >
                  <p className="text-sm text-foreground-secondary whitespace-pre-wrap">
                    {quickError}
                  </p>
                  <button
                    type="button"
                    onClick={handleRetryQuick}
                    className="mt-2 text-sm text-amber-700 hover:text-amber-900 underline flex items-center gap-1"
                  >
                    <ArrowClockwiseIcon className="size-3.5" />
                    {t("latex.tryAgain")}
                  </button>
                </motion.div>
              )}

              {/* Full installer: no TeX distribution found */}
              {showFullInstaller && (
                <motion.div
                  key="full-installer"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <p className="mt-3 text-sm text-amber-700">
                    {t("latex.noTexDistributionWasFoundInstallOneBelow")}
                  </p>

                  {/* Installation Progress (full distro) */}
                  {isInstalling && progress && (
                    <div className="mt-4 p-3 bg-surface-secondary border border-amber-300">
                      <div className="flex items-center gap-2">
                        <Spinner className="size-4" />
                        <span className="text-sm font-medium">{progress.stage}</span>
                      </div>
                      <p className="text-sm text-muted mt-1 break-words">{progress.message}</p>
                      {progress.progress !== null && (
                        <div className="mt-2 h-1.5 bg-amber-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-500 transition-all duration-300"
                            style={{ width: `${progress.progress * 100}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {result && (
                    <div
                      className={`mt-4 p-3 border ${
                        result.success
                          ? "bg-green-50 border-green-300"
                          : "bg-background border-amber-300"
                      }`}
                    >
                      <p
                        className={`text-sm whitespace-pre-wrap ${
                          result.success ? "text-green-700" : "text-foreground-secondary"
                        }`}
                      >
                        {result.message}
                      </p>
                      {result.success && (
                        <div className="mt-3 flex items-center gap-3">
                          <button
                            type="button"
                            onClick={handleRetry}
                            className="btn btn-sm border-2 border-green-600 bg-green-600 text-white hover:bg-green-700 transition-colors"
                          >
                            {t("latex.retrySynctex")}
                          </button>
                          <span className="text-xs text-green-600">
                            {t("latex.clickToNavigateToSource")}
                          </span>
                        </div>
                      )}
                      {!result.success && (
                        <button
                          type="button"
                          onClick={resetInstaller}
                          className="mt-2 text-sm text-amber-700 hover:text-amber-900 underline flex items-center gap-1"
                        >
                          <ArrowClockwiseIcon className="size-3.5" />
                          {t("latex.tryAgain")}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Distribution Options */}
                  {!isInstalling && !result && distributions.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {distributions.map((dist, index) => {
                        const downloadUrl = dist.download_url;

                        return (
                          <div
                            key={dist.id}
                            className={`flex items-center justify-between gap-3 p-3 bg-background border transition-colors ${
                              index === 0
                                ? "border-green-400 hover:border-green-500"
                                : "border-border hover:border-foreground/30"
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-sm flex items-center gap-2">
                                {dist.name}
                                {index === 0 && (
                                  <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 font-normal">
                                    {t("latex.recommended")}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-muted mt-0.5">{dist.description}</p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {dist.install_command && (
                                <button
                                  type="button"
                                  onClick={() => handleInstall(dist.id)}
                                  className={`btn btn-sm border-2 transition-all ${
                                    index === 0
                                      ? "border-green-600 bg-green-600 text-white shadow-[2px_2px_0_0_#22c55e] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px]"
                                      : "border-foreground bg-foreground text-background shadow-[2px_2px_0_0_var(--foreground)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px]"
                                  }`}
                                >
                                  {t("latex.install")}
                                </button>
                              )}
                              {downloadUrl && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenDownload(downloadUrl)}
                                  className={`btn btn-sm border-2 transition-colors ${
                                    index === 0 && !dist.install_command
                                      ? "border-green-600 bg-green-600 text-white hover:bg-green-700"
                                      : "border-border bg-background text-muted hover:bg-accent-hover"
                                  }`}
                                >
                                  {t("latex.download")}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Loading distributions */}
                  {!isInstalling && !result && distributions.length === 0 && (
                    <div className="mt-4 flex items-center gap-2 text-sm text-muted">
                      <Spinner className="size-4" />
                      {t("latex.loadingAvailableDistributions")}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end px-5 py-4 border-t border-border">
            {!isBusy && (
              <button
                type="button"
                onClick={handleClose}
                className="px-6 py-2 text-sm font-medium bg-background text-foreground border-2 border-foreground shadow-[3px_3px_0_0_var(--foreground)] hover:shadow-[1px_1px_0_0_var(--foreground)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all"
              >
                {t("latex.dismiss")}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
