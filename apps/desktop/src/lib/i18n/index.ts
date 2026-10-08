import { createI18n } from "@lmms-lab/i18n";
import { collabEn, collabZh } from "./collab";
import { commonEn, commonZh } from "./common";
import { editorEn, editorZh } from "./editor";
import { settingsEn, settingsZh } from "./settings";

const zh = { ...commonZh, ...collabZh, ...settingsZh, ...editorZh };
const en: Record<keyof typeof zh, string> = {
  ...commonEn,
  ...collabEn,
  ...settingsEn,
  ...editorEn,
};

export const i18n = createI18n({ messages: { zh, en }, storageKey: "writer-locale" });
export const { useI18n } = i18n;
export type MessageKey = keyof typeof zh;
