import {
  fromBase64,
  type LocalFolder,
  RequestError,
  type StateStore,
  type Transport,
  toBase64,
} from "@lmms-lab/sync";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Rust reports server errors as `{"status":…,"message":…}`; 0 means unreachable. */
export function requestError(error: unknown) {
  try {
    const parsed = JSON.parse(String(error)) as { status?: number; message?: string };
    if (typeof parsed.status === "number")
      return new RequestError(parsed.status, parsed.message ?? String(error));
  } catch {
    // A plain message from a local failure.
  }
  return new RequestError(0, error instanceof Error ? error.message : String(error));
}

type SocketEvent = {
  id: number;
  kind: "message" | "close";
  data: string | null;
  code: number | null;
  reason: string | null;
};

/** Requests and the socket run in Rust with the stored device token; the web view never sees it. */
export function desktopTransport(server: string): Transport {
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      try {
        return await invoke<T>("collab_request", { server, method, path, body: body ?? null });
      } catch (error) {
        throw requestError(error);
      }
    },
    connect(path, events) {
      let id: number | null = null,
        closed = false,
        stop: (() => void) | null = null;
      const outbox: string[] = [];
      const early: SocketEvent[] = [];
      const deliver = (event: SocketEvent) => {
        if (event.kind === "message" && event.data !== null) events.message(event.data);
        else if (event.kind === "close") {
          stop?.();
          events.close(event.code ?? 1006, event.reason ?? "");
        }
      };
      void (async () => {
        // Listen first: Rust may report before `collab_connect` returns its id.
        stop = await listen<SocketEvent>("collab-socket", ({ payload }) => {
          if (id === null) early.push(payload);
          else if (payload.id === id) deliver(payload);
        });
        try {
          id = await invoke<number>("collab_connect", { server, path });
        } catch (error) {
          stop();
          events.close(1006, requestError(error).message);
          return;
        }
        if (closed) return void invoke("collab_close", { id });
        for (const event of early.splice(0)) if (event.id === id) deliver(event);
        for (const data of outbox.splice(0))
          void invoke("collab_send", { id, data }).catch(() => {});
      })();
      return {
        send(data) {
          if (id === null) outbox.push(data);
          else void invoke("collab_send", { id, data }).catch(() => {});
        },
        close() {
          closed = true;
          if (id !== null) void invoke("collab_close", { id });
          stop?.();
        },
      };
    },
  };
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The opened project folder; Rust keeps every path inside it and compares before writing. */
export function desktopFolder(project: string): LocalFolder {
  return {
    list: () => invoke<string[]>("sync_list", { project }),
    async read(path) {
      const data = await invoke<string | null>("sync_read", { project, path });
      return data === null ? null : fromBase64(data);
    },
    async write(path, data, expected) {
      return invoke<boolean>("sync_write", {
        project,
        path,
        data: toBase64(data),
        expected: expected ? await sha256(expected) : null,
      });
    },
    async remove(path, expected) {
      return invoke<boolean>("sync_remove", { project, path, expected: await sha256(expected) });
    },
    move: (from, to) => invoke<boolean>("sync_move", { project, from, to }),
  };
}

export function desktopStateStore(project: string): StateStore {
  return {
    load: () => invoke<string | null>("sync_state_load", { project }),
    save: (data) => invoke("sync_state_save", { project, data }),
  };
}
