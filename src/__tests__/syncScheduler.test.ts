import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (state: { activeMessages: unknown[] }) => void;

const mocks = vi.hoisted(() => ({
  sync: {} as Record<string, unknown>,
  chat: { activeMessages: [] as unknown[] },
  chatListeners: new Set<(state: { activeMessages: unknown[] }) => void>(),
}));

vi.mock("@/store/core/syncStore", () => ({
  useSyncStore: {
    getState: () => mocks.sync,
    setState: (patch: Record<string, unknown>) =>
      Object.assign(mocks.sync, patch),
  },
}));
vi.mock("@/store/core/chatStore", () => ({
  useChatStore: {
    getState: () => mocks.chat,
    subscribe: (listener: Listener) => {
      mocks.chatListeners.add(listener);
      return () => mocks.chatListeners.delete(listener);
    },
  },
}));

import {
  SYNC_AFTER_RESPONSE_DELAY_MS,
  startEncryptedSyncScheduler,
} from "@/lib/sync/scheduler";

const streaming = { id: "a", generation: { status: "streaming" } };
const finished = { id: "a", generation: { status: "complete" } };

function setMessages(activeMessages: unknown[]) {
  mocks.chat = { activeMessages };
  mocks.chatListeners.forEach((listener) => listener(mocks.chat));
}

describe("encrypted sync scheduler", () => {
  const syncNow = vi.fn();
  const windowListeners = new Map<string, () => void>();
  let stop: () => void = () => undefined;

  async function start() {
    stop = startEncryptedSyncScheduler();
    // Let the dynamic chat store import resolve.
    await vi.dynamicImportSettled();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    syncNow.mockReset().mockResolvedValue(undefined);
    mocks.sync = { hydrated: true, enabled: true, status: "idle", syncNow };
    mocks.chat = { activeMessages: [] };
    mocks.chatListeners.clear();
    windowListeners.clear();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) =>
        windowListeners.set(type, listener),
      removeEventListener: (type: string) => windowListeners.delete(type),
    });
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not sync when the page opens or on a timer", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(syncNow).not.toHaveBeenCalled();
    expect(windowListeners.has("focus")).toBe(false);
  });

  it("syncs once, three seconds after a response finishes", async () => {
    await start();
    setMessages([streaming]);
    setMessages([streaming]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncNow).not.toHaveBeenCalled();

    setMessages([finished]);
    await vi.advanceTimersByTimeAsync(SYNC_AFTER_RESPONSE_DELAY_MS - 1);
    expect(syncNow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith("response");

    setMessages([finished, { id: "b" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it("waits again when another response starts before the delay", async () => {
    await start();
    setMessages([streaming]);
    setMessages([finished]);
    await vi.advanceTimersByTimeAsync(1_000);
    setMessages([finished, streaming]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncNow).not.toHaveBeenCalled();

    setMessages([finished, finished]);
    await vi.advanceTimersByTimeAsync(SYNC_AFTER_RESPONSE_DELAY_MS);
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it("ignores responses while sync is disabled", async () => {
    mocks.sync.enabled = false;
    await start();
    setMessages([streaming]);
    setMessages([finished]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(syncNow).not.toHaveBeenCalled();
  });

  it("defers a finished response's sync until the browser is online", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await start();
    setMessages([streaming]);
    setMessages([finished]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncNow).not.toHaveBeenCalled();

    vi.stubGlobal("navigator", { onLine: true });
    windowListeners.get("online")?.();
    await vi.advanceTimersByTimeAsync(SYNC_AFTER_RESPONSE_DELAY_MS);
    expect(syncNow).toHaveBeenCalledTimes(1);

    windowListeners.get("online")?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it("retries after a sync that was already running", async () => {
    mocks.sync.status = "syncing";
    await start();
    setMessages([streaming]);
    setMessages([finished]);
    await vi.advanceTimersByTimeAsync(SYNC_AFTER_RESPONSE_DELAY_MS);
    expect(syncNow).not.toHaveBeenCalled();

    mocks.sync.status = "idle";
    await vi.advanceTimersByTimeAsync(SYNC_AFTER_RESPONSE_DELAY_MS);
    expect(syncNow).toHaveBeenCalledTimes(1);
  });
});
