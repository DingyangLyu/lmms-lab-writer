"use client";
import { useEffect, useReducer, useRef } from "react";
import { workbenchI18n as i18n } from "../../i18n";
import type { ChatDraft } from "../chat/outbox";
import type { ConversationInfo, HarnessLifecycle } from "./types";

// Metadata and incoming messages share one adapter contract across all harnesses.
export function usePanelLifecycle(
  props: HarnessLifecycle,
  info: ConversationInfo,
  delivery: {
    ready: boolean;
    busy: boolean;
    preparing: boolean;
    transmit: (draft: ChatDraft) => Promise<void>;
    enqueue: (draft: ChatDraft) => Promise<unknown>;
    onError: (error: string) => void;
  },
) {
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const fingerprint = JSON.stringify(info);
  useEffect(() => {
    callbacks.current.onConversationChange?.(JSON.parse(fingerprint));
  }, [fingerprint]);
  const accepted = useRef(new Set<string>());
  const inFlight = useRef<string | null>(null);
  const failed = useRef<string | null>(null);
  useEffect(() => {
    const incoming = props.incoming;
    if (
      incoming?.state !== "pending" ||
      !delivery.ready ||
      delivery.preparing ||
      inFlight.current ||
      failed.current === incoming.id
    )
      return;
    if (accepted.current.has(incoming.id)) {
      callbacks.current.onIncomingAccepted?.(incoming.id);
      return;
    }
    inFlight.current = incoming.id;
    try {
      callbacks.current.onIncomingState?.(incoming.id, "sending");
    } catch (cause) {
      inFlight.current = null;
      failed.current = incoming.id;
      delivery.onError(
        i18n.t("msg.couldNotSaveTheDelegationRecordSoNothing", { error: String(cause) }),
      );
      return;
    }
    const draft: ChatDraft = { raw: incoming.text, files: [], selection: null };
    // External dispatch never consumes or overwrites the user's composer draft.
    void (delivery.busy ? delivery.enqueue(draft) : delivery.transmit(draft))
      .then(() => {
        accepted.current.add(incoming.id);
        callbacks.current.onIncomingAccepted?.(incoming.id);
      })
      .catch((cause) => {
        failed.current = incoming.id;
        try {
          callbacks.current.onIncomingState?.(incoming.id, "failed");
        } catch {
          /* Keep the persisted pending record for manual recovery. */
        }
        delivery.onError(
          i18n.t("msg.delegationFailedTheTaskIsStillUnderTheTa", { error: String(cause) }),
        );
      })
      .finally(() => {
        inFlight.current = null;
        wake();
      });
  }, [props.incoming, delivery]);
}
