import { useSyncStore } from "@/store/core/syncStore";

const DEBOUNCE_MS = 5_000;
const FOREGROUND_INTERVAL_MS = 5 * 60_000;

let stopActiveScheduler: (() => void) | undefined;

function canRun(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}

export function startEncryptedSyncScheduler(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (stopActiveScheduler) return stopActiveScheduler;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const run = () => {
    if (disposed || !canRun()) return;
    const state = useSyncStore.getState();
    if (!state.hydrated || !state.enabled || state.status === "syncing") return;
    void state.syncNow("scheduled").catch(() => undefined);
  };
  const schedule = () => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, DEBOUNCE_MS);
  };
  const onOnline = () => run();
  const onOffline = () => useSyncStore.setState({ status: "offline" });
  const onFocus = () => run();
  const onVisibility = () => {
    if (document.visibilityState === "visible") run();
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  const interval = setInterval(run, FOREGROUND_INTERVAL_MS);
  const unsubscribers: Array<() => void> = [];
  void Promise.all([
    import("@/store/core/chatStore"),
    import("@/store/core/settingsStore"),
    import("@/store/core/coreSettingsStore"),
    import("@/store/core/knowledgeStore"),
    import("@/store/core/memoryStore"),
  ]).then(([chat, settings, core, knowledge, memory]) => {
    if (disposed) return;
    unsubscribers.push(
      chat.useChatStore.subscribe(schedule),
      settings.useSettingsStore.subscribe(schedule),
      core.useCoreSettingsStore.subscribe(schedule),
      knowledge.useKnowledgeStore.subscribe(schedule),
      memory.useMemoryStore.subscribe(schedule),
    );
  });

  const boot = () => queueMicrotask(run);
  if (useSyncStore.persist.hasHydrated()) boot();
  else unsubscribers.push(useSyncStore.persist.onFinishHydration(boot));

  stopActiveScheduler = () => {
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(interval);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    stopActiveScheduler = undefined;
  };
  return stopActiveScheduler;
}
