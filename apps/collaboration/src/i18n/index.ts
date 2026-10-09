import { createI18n } from "@lmms-lab/i18n";
import { accountEn, accountZh } from "./account";
import { appEn, appZh } from "./app";
import { authEn, authZh } from "./auth";
import { bibliographyEn, bibliographyZh } from "./bibliography";
import { buildEn, buildZh } from "./build";
import { commentsEn, commentsZh } from "./comments";
import { editorEn, editorZh } from "./editor";
import { filesEn, filesZh } from "./files";
import { membersEn, membersZh } from "./members";
import { compareEn, compareZh, reviewEn, reviewZh } from "./review";
import { tasksEn, tasksZh } from "./tasks";
import { workspaceEn, workspaceZh } from "./workspace";

const zh = {
  ...appZh,
  ...accountZh,
  ...authZh,
  ...bibliographyZh,
  ...buildZh,
  ...commentsZh,
  ...compareZh,
  ...editorZh,
  ...filesZh,
  ...membersZh,
  ...reviewZh,
  ...tasksZh,
  ...workspaceZh,
};
const en: Record<keyof typeof zh, string> = {
  ...appEn,
  ...accountEn,
  ...authEn,
  ...bibliographyEn,
  ...buildEn,
  ...commentsEn,
  ...compareEn,
  ...editorEn,
  ...filesEn,
  ...membersEn,
  ...reviewEn,
  ...tasksEn,
  ...workspaceEn,
};

export const i18n = createI18n({ messages: { zh, en }, storageKey: "writer-web-locale" });
export const { useI18n } = i18n;
export type MessageKey = keyof typeof zh;
