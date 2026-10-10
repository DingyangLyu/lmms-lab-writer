import { createI18n } from "@lmms-lab/i18n";
import { accountEn, accountZh } from "./account";
import { agentsEn, agentsZh } from "./agents";
import { appEn, appZh } from "./app";
import { authEn, authZh } from "./auth";
import { bibliographyEn, bibliographyZh } from "./bibliography";
import { buildEn, buildZh } from "./build";
import { commentsEn, commentsZh } from "./comments";
import { dashboardEn, dashboardZh } from "./dashboard";
import { desktopEn, desktopZh } from "./desktop";
import { editorEn, editorZh } from "./editor";
import { filesEn, filesZh } from "./files";
import { membersEn, membersZh } from "./members";
import { notesEn, notesZh } from "./notes";
import { peopleEn, peopleZh } from "./people";
import { compareEn, compareZh, reviewEn, reviewZh } from "./review";
import { shellEn, shellZh } from "./shell";
import { templatesEn, templatesZh } from "./templates";
import { workspaceEn, workspaceZh } from "./workspace";

const zh = {
  ...appZh,
  ...accountZh,
  ...authZh,
  ...bibliographyZh,
  ...buildZh,
  ...commentsZh,
  ...dashboardZh,
  ...desktopZh,
  ...compareZh,
  ...editorZh,
  ...filesZh,
  ...membersZh,
  ...notesZh,
  ...peopleZh,
  ...reviewZh,
  ...shellZh,
  ...templatesZh,
  ...agentsZh,
  ...workspaceZh,
};
const en: Record<keyof typeof zh, string> = {
  ...appEn,
  ...accountEn,
  ...authEn,
  ...bibliographyEn,
  ...buildEn,
  ...commentsEn,
  ...dashboardEn,
  ...desktopEn,
  ...compareEn,
  ...editorEn,
  ...filesEn,
  ...membersEn,
  ...notesEn,
  ...peopleEn,
  ...reviewEn,
  ...shellEn,
  ...templatesEn,
  ...agentsEn,
  ...workspaceEn,
};

export const i18n = createI18n({ messages: { zh, en }, storageKey: "writer-web-locale" });
export const { useI18n } = i18n;
export type MessageKey = keyof typeof zh;
