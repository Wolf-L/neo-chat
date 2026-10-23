import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signedApiFetch: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/client")>()),
  signedApiFetch: mocks.signedApiFetch,
}));
vi.mock("@/store/core/syncStore", () => ({
  useSyncStore: {
    getState: () => mocks.state,
    persist: {
      hasHydrated: () => true,
      onFinishHydration: () => () => undefined,
    },
  },
}));

import { generateRecoveryCode } from "@/lib/sync/crypto";
import { applyServerSyncPreset } from "../overlay/src/lib/sync/customPreset";
import {
  GET,
  getServerSyncPreset,
} from "../overlay/src/lib/sync/customServerPreset";

const PRESET_ENV = {
  ACCESS_PASSWORD: "secret",
  SYNC_PRESET_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  SYNC_PRESET_S3_BUCKET: "neo-chat-sync",
  SYNC_PRESET_S3_ACCESS_KEY_ID: "key-id",
  SYNC_PRESET_S3_SECRET_ACCESS_KEY: "key-secret",
};

async function stubPresetEnv(overrides: Record<string, string> = {}) {
  const { recoveryCode } = await generateRecoveryCode();
  const values = {
    ...PRESET_ENV,
    SYNC_PRESET_RECOVERY_CODE: recoveryCode,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  return values;
}

describe("server sync preset", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is never offered without an access password", async () => {
    await stubPresetEnv({ ACCESS_PASSWORD: "" });
    await expect(getServerSyncPreset()).resolves.toEqual({ available: false });
  });

  it("requires every credential and a valid recovery code", async () => {
    await stubPresetEnv({ SYNC_PRESET_S3_SECRET_ACCESS_KEY: "" });
    await expect(getServerSyncPreset()).resolves.toEqual({ available: false });

    vi.unstubAllEnvs();
    await stubPresetEnv({ SYNC_PRESET_RECOVERY_CODE: "neo-sync-v1.bad.bad" });
    await expect(getServerSyncPreset()).resolves.toEqual({ available: false });

    vi.unstubAllEnvs();
    await stubPresetEnv({ SYNC_PRESET_S3_ENDPOINT: "not a url" });
    await expect(getServerSyncPreset()).resolves.toEqual({ available: false });
  });

  it("returns an R2-ready S3 provider with defaults", async () => {
    const env = await stubPresetEnv({ SYNC_PRESET_S3_PREFIX: "/vault/" });

    await expect(getServerSyncPreset()).resolves.toEqual({
      available: true,
      provider: {
        kind: "s3",
        endpoint: env.SYNC_PRESET_S3_ENDPOINT,
        region: "auto",
        bucket: "neo-chat-sync",
        prefix: "vault",
        forcePathStyle: true,
      },
      credentials: {
        kind: "s3",
        accessKeyId: "key-id",
        secretAccessKey: "key-secret",
      },
      recoveryCode: env.SYNC_PRESET_RECOVERY_CODE,
    });
  });

  it("serves the preset without caching", async () => {
    await stubPresetEnv();
    const response = await GET();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ available: true });
  });
});

describe("client sync preset", () => {
  const configureProvider = vi.fn();
  const initializeVault = vi.fn();
  const syncNow = vi.fn();

  function setLocalState(state: Record<string, unknown> = {}) {
    mocks.state = {
      enabled: false,
      configureProvider,
      initializeVault,
      syncNow,
      ...state,
    };
  }

  beforeEach(() => {
    mocks.signedApiFetch.mockReset();
    configureProvider.mockReset().mockResolvedValue(undefined);
    initializeVault.mockReset().mockResolvedValue(undefined);
    syncNow.mockReset().mockResolvedValue(undefined);
    setLocalState();
  });

  it("joins the preset vault on a device without sync setup", async () => {
    const preset = {
      available: true,
      provider: { kind: "s3", bucket: "neo-chat-sync" },
      credentials: { kind: "s3", accessKeyId: "a", secretAccessKey: "b" },
      recoveryCode: "code",
    };
    mocks.signedApiFetch.mockResolvedValue(Response.json(preset));

    await expect(applyServerSyncPreset()).resolves.toBe("applied");
    expect(mocks.signedApiFetch).toHaveBeenCalledWith(
      "/api/sync/custom-preset",
      expect.objectContaining({ method: "GET" }),
    );
    expect(configureProvider).toHaveBeenCalledWith(
      preset.provider,
      preset.credentials,
    );
    expect(initializeVault).toHaveBeenCalledWith("code");
    // The scheduler starts the first sync, not the preset join.
    expect(syncNow).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: true },
    { provider: { kind: "webdav" } },
    { vaultId: "existing-vault" },
  ])("leaves an existing or disabled setup alone (%o)", async (state) => {
    setLocalState(state);

    await expect(applyServerSyncPreset()).resolves.toBe("skipped");
    expect(mocks.signedApiFetch).not.toHaveBeenCalled();
    expect(configureProvider).not.toHaveBeenCalled();
  });

  it("does nothing when the deployment has no preset", async () => {
    mocks.signedApiFetch.mockResolvedValue(Response.json({ available: false }));

    await expect(applyServerSyncPreset()).resolves.toBe("unavailable");
    expect(configureProvider).not.toHaveBeenCalled();
  });

  it("shares one request between concurrent callers", async () => {
    mocks.signedApiFetch.mockResolvedValue(Response.json({ available: false }));

    await Promise.all([applyServerSyncPreset(), applyServerSyncPreset()]);
    expect(mocks.signedApiFetch).toHaveBeenCalledTimes(1);
  });
});
