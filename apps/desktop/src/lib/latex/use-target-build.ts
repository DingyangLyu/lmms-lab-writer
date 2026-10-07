import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { readCompilerOverrides } from "./compiler-overrides";
import type { BuildTarget, TargetBuildResult } from "./types";

/** Builds one target at a time; the PDF and the failure handoff stay with the caller. */
export function useTargetBuild({
  projectPath,
  prepare,
  onBuilt,
  onFailed,
}: {
  projectPath: string | null;
  /** Runs before building, e.g. saving open editors; `false` cancels the build. */
  prepare: () => Promise<boolean>;
  onBuilt: (pdf: { relative: string; absolute: string }) => void;
  onFailed: (target: BuildTarget, result: TargetBuildResult) => Promise<void>;
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
      toast(`正在编译 ${target.name} · ${target.mainFile}`);
      try {
        const result = await invoke<TargetBuildResult>("latex_build_target", {
          directory: projectPath,
          target,
          compilerOverrides: readCompilerOverrides(),
        });
        if (result.success && result.pdfPath && result.pdfRelative) {
          onBuilt({ relative: result.pdfRelative, absolute: result.pdfPath });
          toast(`编译完成：${result.pdfRelative}（${result.engine}）`);
        } else await onFailed(target, result);
      } catch (cause) {
        toast(`编译未完成：${String(cause)}`, "error");
      } finally {
        running.current = false;
        setCompiling(false);
      }
    },
    [projectPath, prepare, onBuilt, onFailed, toast],
  );

  /** Synchronous check for flows that must not start while a build runs. */
  const isBuilding = useCallback(() => running.current, []);
  return { compiling, build, isBuilding };
}
