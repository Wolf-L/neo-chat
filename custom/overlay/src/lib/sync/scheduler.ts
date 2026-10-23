// Fork overlay: replaces upstream `src/lib/sync/scheduler.ts` at build time
// (see `custom/apply.mjs`). Keep the exported API identical to upstream.
import type { Message } from "@/types";
import { useSyncStore } from "@/store/core/syncStore";
import { applyServerSyncPreset } from "./customPreset";

// Sync once shortly after a response finishes instead of on every store
// change, focus, or timer tick. Opening the page alone never syncs; the
// server preset join and **Sync now** cover the rest.
export const SYNC_AFTER_RESPONSE_DELAY_MS = 3_000;
// Retries after a failed sync (for example a transient 502 from the bucket).
export const SYNC_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

let stopActiveScheduler: (() => void) | undefined;

function hasStreamingMessage(messages: readonly Message[]): boolean {
  return messages.some((message) => message.generation?.status === "streaming");
}

function isConfigResponse(input: RequestInfo | URL, response: Response) {
  if (!response.ok) return false;
  try {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(String(raw), window.location.href);
    return (
      url.origin === window.location.origin && url.pathname === "/api/config"
    );
  } catch {
    return false;
  }
}

export function startEncryptedSyncScheduler(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (stopActiveScheduler) return stopActiveScheduler;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // A sync that has not started yet (for example while offline or while
  // another sync was running).
  let pending = false;
  let pendingReason = "response";
  let failures = 0;

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
      schedule(pendingReason, SYNC_AFTER_RESPONSE_DELAY_MS);
      return;
    }
    pending = false;
    const reason = pendingReason;
    state.syncNow(reason).then(
      () => {
        failures = 0;
      },
      () => {
        const delay = SYNC_RETRY_DELAYS_MS[failures];
        if (delay === undefined) {
          failures = 0;
          return;
        }
        failures += 1;
        schedule(reason, delay);
      },
    );
  };
  const schedule = (reason: string, delay: number) => {
    if (disposed) return;
    pending = true;
    pendingReason = reason;
    clearTimer();
    timer = setTimeout(run, delay);
  };
  const onResponseFinished = () => {
    failures = 0;
    schedule("response", SYNC_AFTER_RESPONSE_DELAY_MS);
  };
  const joinPreset = () => {
    void applyServerSyncPreset().then(
      (result) => {
        if (result === "applied") schedule("preset", 0);
      },
      () => undefined,
    );
  };
  const onOnline = () => {
    if (pending) {
      schedule(pendingReason, SYNC_AFTER_RESPONSE_DELAY_MS);
    } else if (useSyncStore.getState().status === "offline") {
      useSyncStore.setState({ status: "idle" });
    }
  };
  const onOffline = () => useSyncStore.setState({ status: "offline" });

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // The app loads `/api/config` right after sign-in and on every chat
  // bootstrap, so a successful config response is the cue to join the
  // server-managed vault without touching upstream components.
  const originalFetch = window.fetch;
  const observedFetch: typeof window.fetch = async (...args) => {
    const response = await originalFetch.apply(window, args);
    if (!disposed && isConfigResponse(args[0], response)) joinPreset();
    return response;
  };
  if (typeof originalFetch === "function") window.fetch = observedFetch;
  joinPreset();

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
        else onResponseFinished();
      }),
    );
  });

  stopActiveScheduler = () => {
    disposed = true;
    clearTimer();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    if (window.fetch === observedFetch) window.fetch = originalFetch;
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    stopActiveScheduler = undefined;
  };
  return stopActiveScheduler;
}
