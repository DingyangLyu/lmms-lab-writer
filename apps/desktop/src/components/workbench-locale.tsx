"use client";
import { WorkbenchLocale } from "@lmms-lab/workbench";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

/** The shared workbench components follow the desktop's interface language. */
export function WorkbenchLocaleBridge({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  return <WorkbenchLocale locale={locale}>{children}</WorkbenchLocale>;
}
