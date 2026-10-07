import type { Role } from "../shared/api";
import type { SyncStatus } from "./provider";

export const roleName: Record<Role, string> = {
  owner: "所有者",
  editor: "编辑者",
  commenter: "批注者",
  viewer: "只读",
};
export const statusName: Record<SyncStatus, string> = {
  connecting: "正在连接",
  saved: "服务器已保存",
  saving: "正在同步保存",
  offline: "离线 · 草稿留在本机",
  denied: "权限已改变 · 本机草稿保留",
};
