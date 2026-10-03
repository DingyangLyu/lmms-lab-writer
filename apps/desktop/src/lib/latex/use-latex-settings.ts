import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BuildTarget,
  DEFAULT_LATEX_SETTINGS,
  type LaTeXSettings,
  type ProjectBuildConfig,
} from "./types";
export function makeBuildTarget(mainFile: string): BuildTarget {
  const slash = mainFile.lastIndexOf("/");
  const dir = slash >= 0 ? mainFile.slice(0, slash) : ".";
  return {
    id: `target-${crypto.randomUUID()}`,
    name: mainFile.replace(/\.tex$/i, ""),
    mainFile,
    engine: "auto",
    workDir: dir,
    outputDir: dir,
  };
}
export function useLatexSettings(projectPath: string | null) {
  const [config, setConfig] = useState<ProjectBuildConfig>(DEFAULT_LATEX_SETTINGS.config);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedProject, setLoadedProject] = useState<string | null>(null);
  const projectRef = useRef(projectPath);
  projectRef.current = projectPath;
  const serial = useRef(Promise.resolve());
  const reload = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      let legacy: string | null = null;
      try {
        legacy = JSON.parse(localStorage.getItem("latex-settings") || "null")?.mainFile ?? null;
      } catch {
        /* Ignore an invalid legacy preference. */
      }
      const next = await invoke<ProjectBuildConfig>("latex_project_load", {
        directory: projectPath,
        legacyMainFile: legacy,
      });
      if (projectRef.current === projectPath) {
        setConfig(next);
        setLoadedProject(projectPath);
      }
    } catch (cause) {
      if (projectRef.current === projectPath) setError(String(cause));
    } finally {
      if (projectRef.current === projectPath) setLoading(false);
    }
  }, [projectPath]);
  useEffect(() => {
    setConfig(DEFAULT_LATEX_SETTINGS.config);
    setLoadedProject(null);
    if (projectPath) void reload();
  }, [projectPath, reload]);
  const saveConfig = useCallback(
    async (next: ProjectBuildConfig) => {
      if (!projectPath) throw new Error("请先打开项目");
      setSaving(true);
      setError(null);
      const save = serial.current
        .catch(() => {})
        .then(() => invoke<void>("latex_project_save", { directory: projectPath, config: next }));
      serial.current = save;
      try {
        await save;
        if (projectRef.current === projectPath) {
          setConfig(next);
          setLoadedProject(projectPath);
        }
      } catch (cause) {
        if (projectRef.current === projectPath) setError(String(cause));
        throw cause;
      } finally {
        if (projectRef.current === projectPath) setSaving(false);
      }
    },
    [projectPath],
  );
  const current = loadedProject === projectPath ? config : DEFAULT_LATEX_SETTINGS.config;
  const activeTarget =
    current.targets.find((t) => t.id === current.activeTarget) ?? current.targets[0] ?? null;
  const settings: LaTeXSettings = { mainFile: activeTarget?.mainFile ?? null, config: current };
  const setMainFile = useCallback(
    async (mainFile: string | null) => {
      const existing = config.targets.find((t) => t.mainFile === mainFile);
      const target = existing || (mainFile ? makeBuildTarget(mainFile) : null);
      await saveConfig({
        ...config,
        activeTarget: target?.id ?? null,
        targets: target && !existing ? [...config.targets, target] : config.targets,
      });
    },
    [config, saveConfig],
  );
  const updateSettings = useCallback(
    (updates: Partial<LaTeXSettings>) => {
      if (updates.config) void saveConfig(updates.config).catch(() => {});
      else if (updates.mainFile !== undefined) void setMainFile(updates.mainFile).catch(() => {});
    },
    [saveConfig, setMainFile],
  );
  return {
    settings,
    activeTarget,
    saveConfig,
    selectTarget: (id: string) => saveConfig({ ...config, activeTarget: id }),
    setMainFile,
    updateSettings,
    reload,
    error,
    saving,
    isDetecting: loading || loadedProject !== projectPath,
  };
}
