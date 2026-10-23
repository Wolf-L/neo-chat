// Fork overlay: client side of the server-managed sync vault.
import { readJsonResponseOrThrow, signedApiFetch } from "@/lib/api/client";
import type {
  SyncProviderConfig,
  SyncProviderCredentials,
} from "@/lib/sync/types";
import { useSyncStore } from "@/store/core/syncStore";

export const SYNC_PRESET_ENDPOINT = "/api/sync/custom-preset";

/**
 * Server-managed sync settings handed to signed-in clients so encrypted sync
 * can be enabled without manual setup. Only offered behind an access password.
 */
export type SyncServerPreset =
  | { available: false }
  | {
      available: true;
      provider: Extract<SyncProviderConfig, { kind: "s3" }>;
      credentials: Extract<SyncProviderCredentials, { kind: "s3" }>;
      recoveryCode: string;
    };

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

  const response = await signedApiFetch(SYNC_PRESET_ENDPOINT, {
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

  await useSyncStore
    .getState()
    .configureProvider(preset.provider, preset.credentials);
  await useSyncStore.getState().initializeVault(preset.recoveryCode);
  return "applied";
}

/**
 * Joins the deployment's server-managed sync vault on first sign-in. Devices
 * that already have a sync setup, including a disabled one, are left alone.
 * The caller starts the first sync.
 */
export function applyServerSyncPreset(): Promise<SyncPresetResult> {
  pending ??= applyPreset().finally(() => {
    pending = undefined;
  });
  return pending;
}
