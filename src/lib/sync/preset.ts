import { readJsonResponseOrThrow, signedApiFetch } from "@/lib/api/client";
import { useSyncStore } from "@/store/core/syncStore";
import type { SyncServerPreset } from "./types";

export type SyncPresetResult = "applied" | "skipped" | "unavailable";

let pending: Promise<SyncPresetResult> | undefined;

function waitForSyncHydration(): Promise<void> {
  if (useSyncStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useSyncStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

function hasLocalSyncSetup(): boolean {
  const state = useSyncStore.getState();
  // A stored provider or vault means the user already chose a setup (or
  // turned sync off afterwards); never replace that with the server preset.
  return Boolean(state.enabled || state.provider || state.vaultId);
}

async function applyPreset(): Promise<SyncPresetResult> {
  await waitForSyncHydration();
  if (hasLocalSyncSetup()) return "skipped";

  const response = await signedApiFetch("/api/sync/preset", {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) return "unavailable";
  const preset = await readJsonResponseOrThrow<SyncServerPreset>(
    response,
    "Failed to load the sync preset",
  );
  if (!preset.available) return "unavailable";
  if (hasLocalSyncSetup()) return "skipped";

  const store = useSyncStore.getState();
  await store.configureProvider(preset.provider, preset.credentials);
  await useSyncStore.getState().initializeVault(preset.recoveryCode);
  void useSyncStore
    .getState()
    .syncNow("preset")
    .catch(() => undefined);
  return "applied";
}

/**
 * Joins the deployment's server-managed sync vault on first sign-in. Devices
 * that already have a sync setup, including a disabled one, are left alone.
 */
export function applyServerSyncPreset(): Promise<SyncPresetResult> {
  pending ??= applyPreset().finally(() => {
    pending = undefined;
  });
  return pending;
}
