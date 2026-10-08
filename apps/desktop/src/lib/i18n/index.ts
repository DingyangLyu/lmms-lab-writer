import { createI18n } from "@lmms-lab/i18n";
import { agentsEn, agentsZh } from "./agents";
import { collabEn, collabZh } from "./collab";
import { commonEn, commonZh } from "./common";
import { editorEn, editorZh } from "./editor";
import { pageEn, pageZh } from "./page";
import { settingsEn, settingsZh } from "./settings";

const zh = {
  ...agentsZh,
  ...collabZh,
  ...commonZh,
  ...editorZh,
  ...pageZh,
  ...settingsZh,
};
const en: Record<keyof typeof zh, string> = {
  ...agentsEn,
  ...collabEn,
  ...commonEn,
  ...editorEn,
  ...pageEn,
  ...settingsEn,
};

export const i18n = createI18n({ messages: { zh, en }, storageKey: "writer-locale" });
export const { useI18n } = i18n;
export type MessageKey = keyof typeof zh;
