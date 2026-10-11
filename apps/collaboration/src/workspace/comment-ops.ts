/**
 * Writing to comment threads the way a chat app does: the change shows at once and the request
 * runs behind it. If the server refuses, the change is taken back and the reason shown (a reply
 * being typed is kept for another try).
 */
import { useMemo } from "react";
import type { Comment, PublicUser, Reply } from "../../shared/api";
import { api, errorText } from "../api";
import { type CommentDraft, postDraft } from "./notes";
import type { CommentChange } from "./use-project";

/** An id for a new comment or reply, chosen here so it can be shown before the server answers. */
export function newId() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type CommentOps = {
  /**
   * Shows the comment at once and posts it: its id now, and the comment as the server has it
   * (null if the server refused, when it is taken away again).
   */
  post: (
    draft: CommentDraft,
    place: { line: number | null; start?: string; end?: string },
  ) => { id: string; done: Promise<Comment | null> };
  /** Rejects when the reply was refused, so the thread keeps the text. */
  reply: (comment: string, body: string) => Promise<void>;
  resolve: (id: string, resolved: boolean) => void;
  edit: (id: string, body: string) => void;
  remove: (id: string) => void;
  editReply: (comment: string, id: string, body: string) => void;
  removeReply: (comment: string, id: string) => void;
  /** Records that these comments were handed to an AI conversation (`target` names it). */
  handoff: (ids: string[], target: string) => void;
};

const patch = (id: string, change: (c: Comment) => Comment) => (list: Comment[]) =>
  list.map((c) => (c.id === id ? change(c) : c));

export function useCommentOps({
  prefix,
  user,
  change,
  report,
}: {
  prefix: string;
  user: PublicUser;
  change: (apply: (list: Comment[]) => Comment[]) => CommentChange;
  report: (message: string) => void;
}): CommentOps {
  return useMemo(() => {
    /** Shows `apply` now and runs `request`; returns its result, or throws after undoing. */
    const optimistic = async <T>(
      apply: (list: Comment[]) => Comment[],
      request: () => Promise<T>,
      answered?: (result: T, shown: CommentChange) => void,
    ) => {
      const shown = change(apply);
      try {
        const result = await request();
        answered?.(result, shown);
        shown.settle();
        return result;
      } catch (error) {
        shown.undo();
        report(errorText(error));
        throw error;
      }
    };
    const quietly = (run: () => Promise<unknown>) => void run().catch(() => {});
    return {
      post: (draft, place) => {
        const id = newId(),
          now = Date.now();
        const local: Comment = {
          id,
          file: draft.file,
          author: user.id,
          authorName: user.name,
          quote: draft.quote,
          start: place.start ?? draft.start ?? "",
          end: place.end ?? draft.end ?? "",
          body: draft.body,
          resolved: false,
          created: now,
          updated: now,
          edited: null,
          from: draft.from,
          to: draft.to,
          line: place.line,
          excerpt: draft.excerpt ?? draft.quote,
          pdf: draft.pdf ?? null,
          replies: [],
          handoffs: [],
          pending: true,
        };
        const add = (comment: Comment) => (list: Comment[]) => [
          comment,
          ...list.filter((c) => c.id !== id),
        ];
        const done = optimistic(
          add(local),
          () => postDraft(prefix, draft, id) as Promise<{ comment?: Comment }>,
          (result, shown) => {
            if (result.comment) shown.update(add(result.comment));
          },
        ).then(
          (result) => result.comment ?? local,
          () => null,
        );
        return { id, done };
      },
      reply: async (comment, body) => {
        const reply: Reply = {
          id: newId(),
          comment,
          author: user.id,
          authorName: user.name,
          body,
          created: Date.now(),
          edited: null,
        };
        await optimistic(
          patch(comment, (c) => ({
            ...c,
            replies: [...c.replies.filter((r) => r.id !== reply.id), reply],
          })),
          () => api(`${prefix}/comments/${comment}/reply`, { id: reply.id, body }),
        );
      },
      resolve: (id, resolved) =>
        quietly(() =>
          optimistic(
            patch(id, (c) => ({ ...c, resolved })),
            () => api(`${prefix}/comments/${id}`, { resolved }, "PATCH"),
          ),
        ),
      edit: (id, body) =>
        quietly(() =>
          optimistic(
            patch(id, (c) => ({ ...c, body, edited: c.body === body ? c.edited : Date.now() })),
            () => api(`${prefix}/comments/${id}`, { body }, "PATCH"),
          ),
        ),
      remove: (id) =>
        quietly(() =>
          optimistic(
            (list) => list.filter((c) => c.id !== id),
            () => api(`${prefix}/comments/${id}`, {}, "DELETE"),
          ),
        ),
      editReply: (comment, id, body) =>
        quietly(() =>
          optimistic(
            patch(comment, (c) => ({
              ...c,
              replies: c.replies.map((r) =>
                r.id === id ? { ...r, body, edited: r.body === body ? r.edited : Date.now() } : r,
              ),
            })),
            () => api(`${prefix}/replies/${id}`, { body }, "PATCH"),
          ),
        ),
      removeReply: (comment, id) =>
        quietly(() =>
          optimistic(
            patch(comment, (c) => ({ ...c, replies: c.replies.filter((r) => r.id !== id) })),
            () => api(`${prefix}/replies/${id}`, {}, "DELETE"),
          ),
        ),
      handoff: (ids, target) => {
        const now = Date.now();
        quietly(() =>
          optimistic(
            (list) =>
              list.map((c) =>
                ids.includes(c.id) &&
                !c.handoffs.some(
                  (h) =>
                    h.actor === user.id &&
                    h.target === target &&
                    Math.abs(h.created - now) < 120_000,
                )
                  ? {
                      ...c,
                      handoffs: [
                        ...c.handoffs,
                        { actor: user.id, actorName: user.name, target, created: now },
                      ],
                    }
                  : c,
              ),
            () => api(`${prefix}/comments/handoff`, { ids, target }),
          ),
        );
      },
    };
  }, [prefix, user, change, report]);
}
