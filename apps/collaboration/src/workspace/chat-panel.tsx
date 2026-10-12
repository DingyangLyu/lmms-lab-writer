/** The project's chat in the rail: every member can read and write; new messages arrive live. */
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../shared/api";
import { api, errorText } from "../api";
import { Avatar } from "../avatar";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { CHAT_EVENT } from "./use-project";

export type ChatEvent = CustomEvent<{ project: string; message: ChatMessage }>;

export function ChatPanel({ ws }: { ws: WorkspaceContext }) {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[] | null>(null),
    [text, setText] = useState(""),
    [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const { prefix, project, report } = ws;
  useEffect(() => {
    void api<ChatMessage[]>(`${prefix}/chat`)
      .then(setMessages)
      .catch((e) => report(errorText(e)));
    const arrived = (event: Event) => {
      const { detail } = event as ChatEvent;
      if (detail.project !== project.id) return;
      setMessages((old) =>
        old && !old.some((m) => m.id === detail.message.id) ? [...old, detail.message] : old,
      );
    };
    window.addEventListener(CHAT_EVENT, arrived);
    return () => window.removeEventListener(CHAT_EVENT, arrived);
  }, [prefix, project.id, report]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest when one arrives.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages?.length]);
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const message = await api<ChatMessage>(`${prefix}/chat`, { body });
      setMessages((old) =>
        old?.some((m) => m.id === message.id) ? old : [...(old ?? []), message],
      );
      setText("");
    } catch (e) {
      report(errorText(e));
    } finally {
      setSending(false);
    }
  };
  const time = (ms: number) =>
    new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <section aria-label={t("chat.title")} className="flex min-h-0 flex-1 flex-col text-xs">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <strong>{t("chat.title")}</strong>
      </header>
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages && !messages.length && <p className="text-muted">{t("chat.empty")}</p>}
        {messages?.map((m, i) => {
          const previous = messages[i - 1];
          // Messages from the same person within five minutes read as one block.
          const continued =
            previous && previous.author === m.author && m.created - previous.created < 300_000;
          return (
            <div key={m.id} className={`flex gap-2 ${continued ? "-mt-2" : ""}`}>
              <span className="w-6 shrink-0">
                {!continued && (
                  <Avatar
                    person={{ id: m.author, name: m.authorName, avatar: m.authorAvatar }}
                    size={24}
                  />
                )}
              </span>
              <div className="min-w-0 flex-1">
                {!continued && (
                  <p className="mb-0.5">
                    <strong className={m.author === ws.user.id ? "text-accent" : ""}>
                      {m.authorName}
                    </strong>
                    <span className="ml-2 text-muted">{time(m.created)}</span>
                  </p>
                )}
                <p className="whitespace-pre-wrap break-words leading-relaxed">{m.body}</p>
              </div>
            </div>
          );
        })}
      </div>
      <form
        className="flex shrink-0 items-end gap-2 border-t border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label={t("chat.message")}
          placeholder={t("chat.placeholder")}
          value={text}
          rows={2}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="min-h-0 flex-1 resize-none border border-border bg-background px-2 py-1 focus:border-foreground focus:outline-none"
        />
        <button
          type="submit"
          aria-label={t("chat.send")}
          title={t("chat.send")}
          disabled={!text.trim() || sending}
          className="flex size-8 items-center justify-center border border-border hover:bg-accent-hover disabled:opacity-40"
        >
          <PaperPlaneRightIcon className="size-4" />
        </button>
      </form>
    </section>
  );
}
