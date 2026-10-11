import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { type SyncLink, serverRequest } from "@/lib/collab/accounts";
import { i18n } from "@/lib/i18n";
import { readCompilerOverrides } from "./compiler-overrides";
import type { BuildTarget, TargetBuildResult } from "./types";

/** A build on the server a folder is linked to (the web's builds). */
export type ServerBuild = {
  id: string;
  main: string;
  engine: string;
  status: "success" | "failed";
  issues: Array<{
    level: "error" | "warning";
    file: string | null;
    line: number | null;
    message: string;
  }>;
  log: string;
  pdf: boolean;
};
/** Where a linked folder builds: this computer's TeX, or the server's. */
export type BuildServer = { link: SyncLink; flush: () => Promise<void> };
/** The server offers pdfLaTeX, XeLaTeX and LuaLaTeX, and chooses itself for "auto". */
const serverEngine = (engine: BuildTarget["engine"]) =>
  engine === "auto" || engine === "latexmk" ? "auto" : engine === "tectonic" ? "xelatex" : engine;
/** The server's build as the local result the failure handoff expects. */
function asResult(build: ServerBuild, server: string): TargetBuildResult {
  const errors = build.issues.filter((i) => i.level === "error");
  return {
    success: build.status === "success",
    pdfPath: null,
    pdfRelative: null,
    engine: build.engine,
    compilerPath: server,
    output: build.issues
      .map((i) => `${i.file ?? ""}${i.line ? `:${i.line}` : ""}${i.file ? ": " : ""}${i.message}`)
      .join("\n"),
    error: errors[0]?.message ?? (build.status === "failed" ? "compilation failed" : null),
    log: build.log,
  };
}

/** Builds one target at a time; the PDF and the failure handoff stay with the caller. */
export function useTargetBuild({
  projectPath,
  prepare,
  onBuilt,
  onFailed,
  server,
}: {
  projectPath: string | null;
  /** Runs before building, e.g. saving open editors; `false` cancels the build. */
  prepare: () => Promise<boolean>;
  /** `build` is set for a server build, whose SyncTeX lookups go to the server. */
  onBuilt: (pdf: { relative: string; absolute: string; build?: ServerBuild }) => void;
  onFailed: (target: BuildTarget, result: TargetBuildResult) => Promise<void>;
  /** Build on the server instead (a folder linked to a server project). */
  server?: BuildServer | null;
}) {
  const { toast } = useToast();
  const [compiling, setCompiling] = useState(false);
  const running = useRef(false);

  const build = useCallback(
    async (target: BuildTarget) => {
      if (!projectPath || running.current) return;
      if (!(await prepare())) return;
      running.current = true;
      setCompiling(true);
      toast(i18n.t("msg.compilingNameFile", { name: target.name, file: target.mainFile }));
      try {
        if (server) {
          // The server builds its copy: everything saved here goes up first.
          await server.flush();
          const { link } = server;
          const build = await serverRequest<ServerBuild>(
            link.server,
            "POST",
            `/api/projects/${link.project}/builds`,
            { main: target.mainFile, engine: serverEngine(target.engine) },
          );
          if (build.pdf) {
            // Where a local build of this target puts its PDF (kept out of the sync).
            const folder =
              target.outputDir === "." || !target.outputDir ? "" : `${target.outputDir}/`;
            const relative = `${folder}${target.mainFile
              .split("/")
              .pop()
              ?.replace(/\.tex$/i, ".pdf")}`;
            const absolute = await invoke<string>("collab_download", {
              server: link.server,
              path: `/api/projects/${link.project}/builds/${build.id}/pdf`,
              project: projectPath,
              dest: relative,
            });
            onBuilt({ relative, absolute, build });
          }
          if (build.status === "success")
            toast(
              i18n.t("msg.compiledPdfOnServer", { pdf: target.mainFile, engine: build.engine }),
            );
          else await onFailed(target, asResult(build, link.server));
          return;
        }
        const result = await invoke<TargetBuildResult>("latex_build_target", {
          directory: projectPath,
          target,
          compilerOverrides: readCompilerOverrides(),
        });
        if (result.success && result.pdfPath && result.pdfRelative) {
          onBuilt({ relative: result.pdfRelative, absolute: result.pdfPath });
          toast(
            i18n.t("msg.compiledPdfEngine", { pdf: result.pdfRelative, engine: result.engine }),
          );
        } else await onFailed(target, result);
      } catch (cause) {
        toast(i18n.t("msg.compilationDidNotFinishError", { error: String(cause) }), "error");
      } finally {
        running.current = false;
        setCompiling(false);
      }
    },
    [projectPath, prepare, onBuilt, onFailed, toast, server],
  );

  /** Synchronous check for flows that must not start while a build runs. */
  const isBuilding = useCallback(() => running.current, []);
  return { compiling, build, isBuilding };
}
