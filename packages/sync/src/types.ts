/** How the folder sync reaches the server, the disk and its saved state; each app supplies these. */

export type RemoteFile = { id: string; path: string; binary: boolean; revision: number };
export type Role = "owner" | "editor" | "commenter" | "viewer";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SocketEvents {
  message(data: string): void;
  close(code: number, reason: string): void;
}
export interface SocketHandle {
  send(data: string): void;
  close(): void;
}
export interface Transport {
  /** A JSON API call (`path` starts with `/api/`); non-2xx answers throw RequestError. */
  request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T>;
  /** Opens a WebSocket on `path`; failures to connect arrive as `close`. */
  connect(path: string, events: SocketEvents): SocketHandle;
}

/** The synced folder. Paths are project-relative with "/" separators. */
export interface LocalFolder {
  /** Candidate files; private and generated directories are already left out. */
  list(): Promise<string[]>;
  /** null when the file does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Writes only if the file still holds `expected` (null: must not exist); false otherwise. */
  write(path: string, data: Uint8Array, expected: Uint8Array | null): Promise<boolean>;
  /** Removes only if the file still holds `expected`. */
  remove(path: string, expected: Uint8Array): Promise<boolean>;
  /** Moves a file unless `to` exists; false when nothing moved. */
  move(from: string, to: string): Promise<boolean>;
}

/** Where the last synced state lives between runs (one JSON string). */
export interface StateStore {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

export type SyncState =
  | "connecting"
  | "syncing"
  | "synced"
  | "offline"
  | "paused"
  | "signed-out"
  | "stopped";
export type SyncStatus = {
  state: SyncState;
  role: Role | null;
  /** Local changes not yet confirmed by the server. */
  pending: number;
  lastSynced: number | null;
  error: string | null;
};
/** Things the user should hear about; apps word them in their own language. */
export type SyncNotice =
  | { kind: "conflict-copy"; path: string; copy: string }
  | { kind: "deleted-remotely"; path: string; copy: string }
  | { kind: "read-only"; path: string }
  | {
      kind: "not-synced";
      path: string;
      reason: "path" | "size" | "encoding" | "server";
      detail?: string;
    }
  | { kind: "paused-missing"; count: number };
