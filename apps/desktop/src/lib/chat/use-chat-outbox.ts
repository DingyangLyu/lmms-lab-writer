"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatOutbox, outboxStorage, type QueuedMessage } from "./outbox";
export function useChatOutbox({
  scope,
  ready,
  busy,
  completion,
  deliver,
}: {
  scope: string | null;
  ready: boolean;
  busy: boolean;
  completion: number;
  deliver: (message: QueuedMessage) => Promise<void>;
}) {
  const deliveryRef = useRef({ scope, deliver });
  deliveryRef.current = { scope, deliver };
  const [, refresh] = useState(0);
  const outbox = useMemo(
    () =>
      new ChatOutbox(scope || "unbound", outboxStorage, (message) => {
        if (deliveryRef.current.scope !== scope) throw new Error("对话已切换，队列保持原对话。");
        return deliveryRef.current.deliver(message);
      }),
    [scope],
  );
  useEffect(() => {
    const unsubscribe = outbox.subscribe(() => refresh((value) => value + 1));
    if (scope) void outbox.load();
    return () => {
      outbox.update({ ready: false, busy: true, completion: 0 });
      unsubscribe();
    };
  }, [outbox, scope]);
  useEffect(() => {
    outbox.update({ ready: ready && Boolean(scope), busy, completion });
  }, [outbox, ready, busy, completion, scope]);
  return outbox;
}
