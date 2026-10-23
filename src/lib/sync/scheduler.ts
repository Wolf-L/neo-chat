import type { Message } from "@/types";
import { useSyncStore } from "@/store/core/syncStore";

// Sync once shortly after a response finishes instead of on every store
// change, focus, or timer tick. Opening the page alone never syncs; the
// server preset join (see `preset.ts`) and **Sync now** cover the rest.
export const SYNC_AFTER_RESPONSE_DELAY_MS = 3_000;

let stopActiveScheduler: (() => void) | undefined;

function hasStreamingMessage(messages: readonly Message[]): boolean {
  return messages.some((message) => message.generation?.status === "streaming");
}

export function startEncryptedSyncScheduler(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (stopActiveScheduler) return stopActiveScheduler;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // A finished response whose sync has not started yet (for example while
  // offline or while another sync was running).
  let pending = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const run = () => {
    timer = undefined;
    if (disposed || !pending) return;
    const state = useSyncStore.getState();
    if (!state.hydrated || !state.enabled) {
      pending = false;
      return;
    }
    if (!navigator.onLine) return;
    if (state.status === "syncing") {
      schedule();
      return;
    }
    pending = false;
    void state.syncNow("response").catch(() => undefined);
  };
  const schedule = () => {
    if (disposed) return;
    pending = true;
    clearTimer();
    timer = setTimeout(run, SYNC_AFTER_RESPONSE_DELAY_MS);
  };
  const onOnline = () => {
    if (pending) {
      schedule();
    } else if (useSyncStore.getState().status === "offline") {
      useSyncStore.setState({ status: "idle" });
    }
  };
  const onOffline = () => useSyncStore.setState({ status: "offline" });

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  const unsubscribers: Array<() => void> = [];
  void import("@/store/core/chatStore").then(({ useChatStore }) => {
    if (disposed) return;
    let streaming = hasStreamingMessage(useChatStore.getState().activeMessages);
    unsubscribers.push(
      useChatStore.subscribe((state) => {
        const next = hasStreamingMessage(state.activeMessages);
        if (next === streaming) return;
        streaming = next;
        // Another response started: wait for it to finish as well.
        if (next) clearTimer();
        else schedule();
      }),
    );
  });

  stopActiveScheduler = () => {
    disposed = true;
    clearTimer();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    stopActiveScheduler = undefined;
  };
  return stopActiveScheduler;
}
