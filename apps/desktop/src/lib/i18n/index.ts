import { createI18n } from "@lmms-lab/i18n";
import { collabEn, collabZh } from "./collab";
import { commonEn, commonZh } from "./common";

const zh = { ...commonZh, ...collabZh };
const en: Record<keyof typeof zh, string> = { ...commonEn, ...collabEn };

export const i18n = createI18n({ messages: { zh, en }, storageKey: "writer-locale" });
export const { useI18n } = i18n;
export type MessageKey = keyof typeof zh;
