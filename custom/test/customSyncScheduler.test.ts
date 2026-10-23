import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (state: { activeMessages: unknown[] }) => void;

const mocks = vi.hoisted(() => ({
  sync: {} as Record<string, unknown>,
  chat: { activeMessages: [] as unknown[] },
  chatListeners: new Set<(state: { activeMessages: unknown[] }) => void>(),
  applyServerSyncPreset: vi.fn(),
}));

vi.mock("../overlay/src/lib/sync/customPreset", () => ({
  applyServerSyncPreset: mocks.applyServerSyncPreset,
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
  SYNC_RETRY_DELAYS_MS,
  startEncryptedSyncScheduler,
} from "../overlay/src/lib/sync/scheduler";

const streaming = { id: "a", generation: { status: "streaming" } };
const finished = { id: "a", generation: { status: "complete" } };

function setMessages(activeMessages: unknown[]) {
  mocks.chat = { activeMessages };
  mocks.chatListeners.forEach((listener) => listener(mocks.chat));
}

describe("encrypted sync scheduler", () => {
  const syncNow = vi.fn();
  const windowListeners = new Map<string, () => void>();
  const fetchMock = vi.fn();
  const fakeWindow = {
    location: { href: "https://chat.example/", origin: "https://chat.example" },
    fetch: fetchMock as unknown as typeof fetch,
    addEventListener: (type: string, listener: () => void) =>
      windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type),
  };
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
    fetchMock.mockReset().mockResolvedValue(new Response("{}"));
    fakeWindow.fetch = fetchMock as unknown as typeof fetch;
    mocks.applyServerSyncPreset.mockReset().mockResolvedValue("skipped");
    vi.stubGlobal("window", fakeWindow);
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

  it("retries a failed sync, then gives up until the next response", async () => {
    syncNow.mockRejectedValue(new Error("502"));
    await start();
    setMessages([streaming]);
    setMessages([finished]);
    await vi.advanceTimersByTimeAsync(SYNC_AFTER_RESPONSE_DELAY_MS);
    expect(syncNow).toHaveBeenCalledTimes(1);

    for (const [index, delay] of SYNC_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(syncNow).toHaveBeenCalledTimes(index + 2);
    }
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncNow).toHaveBeenCalledTimes(SYNC_RETRY_DELAYS_MS.length + 1);

    syncNow.mockResolvedValue(undefined);
    setMessages([streaming]);
    setMessages([finished]);
    await vi.advanceTimersByTimeAsync(SYNC_AFTER_RESPONSE_DELAY_MS);
    expect(syncNow).toHaveBeenCalledTimes(SYNC_RETRY_DELAYS_MS.length + 2);
  });

  it("joins the server preset on start and syncs right away", async () => {
    mocks.applyServerSyncPreset.mockResolvedValue("applied");
    await start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.applyServerSyncPreset).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith("preset");
  });

  it("joins the server preset after the config loads", async () => {
    await start();
    expect(mocks.applyServerSyncPreset).toHaveBeenCalledTimes(1);

    await window.fetch("/api/models");
    await window.fetch("https://other.example/api/config");
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    await window.fetch("/api/config");
    expect(mocks.applyServerSyncPreset).toHaveBeenCalledTimes(1);

    mocks.applyServerSyncPreset.mockResolvedValue("applied");
    const response = await window.fetch(
      new Request("https://chat.example/api/config?x=1"),
    );
    expect(response.ok).toBe(true);
    expect(mocks.applyServerSyncPreset).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncNow).toHaveBeenCalledWith("preset");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("restores the original fetch when stopped", async () => {
    await start();
    expect(window.fetch).not.toBe(fetchMock);

    stop();
    expect(window.fetch).toBe(fetchMock);
  });
});
