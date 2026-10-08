import type { Role } from "../shared/api";
import type { MessageKey } from "./i18n";
import type { SyncStatus } from "./provider";

export const roleKey: Record<Role, MessageKey> = {
  owner: "role.owner",
  editor: "role.editor",
  commenter: "role.commenter",
  viewer: "role.viewer",
};
export const statusKey: Record<SyncStatus, MessageKey> = {
  connecting: "status.connecting",
  saved: "status.saved",
  saving: "status.saving",
  offline: "status.offline",
  denied: "status.denied",
};
