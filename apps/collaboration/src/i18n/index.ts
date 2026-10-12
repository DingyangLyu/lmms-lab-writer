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
import { gitEn, gitZh } from "./git";
import { landingEn, landingZh } from "./landing";
import { membersEn, membersZh } from "./members";
import { notesEn, notesZh } from "./notes";
import { peopleEn, peopleZh } from "./people";
import { railEn, railZh } from "./rail";
import { compareEn, compareZh, reviewEn, reviewZh } from "./review";
import { shellEn, shellZh } from "./shell";
import { templatesEn, templatesZh } from "./templates";
import { trackedEn, trackedZh } from "./tracked";
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
  ...gitZh,
  ...landingZh,
  ...membersZh,
  ...notesZh,
  ...peopleZh,
  ...railZh,
  ...reviewZh,
  ...shellZh,
  ...templatesZh,
  ...trackedZh,
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
  ...gitEn,
  ...landingEn,
  ...membersEn,
  ...notesEn,
  ...peopleEn,
  ...railEn,
  ...reviewEn,
  ...shellEn,
  ...templatesEn,
  ...trackedEn,
  ...agentsEn,
  ...workspaceEn,
};

export const i18n = createI18n({ messages: { zh, en }, storageKey: "writer-web-locale" });
export const { useI18n } = i18n;
export type MessageKey = keyof typeof zh;
