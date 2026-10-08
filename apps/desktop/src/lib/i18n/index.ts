import { createI18n } from "@lmms-lab/i18n";
import { agentsEn, agentsZh } from "./agents";
import { collabEn, collabZh } from "./collab";
import { commonEn, commonZh } from "./common";
import { editorEn, editorZh } from "./editor";
import { latexEn, latexZh } from "./latex";
import { msgEn, msgZh } from "./messages";
import { pageEn, pageZh } from "./page";
import { settingsEn, settingsZh } from "./settings";
import { uiEn, uiZh } from "./ui";

const zh = {
  ...agentsZh,
  ...collabZh,
  ...commonZh,
  ...editorZh,
  ...latexZh,
  ...msgZh,
  ...pageZh,
  ...settingsZh,
  ...uiZh,
};
const en: Record<keyof typeof zh, string> = {
  ...agentsEn,
  ...collabEn,
  ...commonEn,
  ...editorEn,
  ...latexEn,
  ...msgEn,
  ...pageEn,
  ...settingsEn,
  ...uiEn,
};

export const i18n = createI18n({ messages: { zh, en }, storageKey: "writer-locale" });
export const { useI18n } = i18n;
export type MessageKey = keyof typeof zh;
