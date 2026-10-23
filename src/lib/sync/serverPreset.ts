import "server-only";

import { isAccessPasswordEnabled } from "@/lib/security/accessControl";
import { parseRecoveryCode } from "./crypto";
import { S3ProviderSchema } from "./remoteSchema";
import type { SyncServerPreset } from "./types";

const UNAVAILABLE: SyncServerPreset = { available: false };

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

/**
 * Reads the deployment's shared S3-compatible sync vault. The recovery code
 * and bucket credentials are disclosed to every client that passed the access
 * password, so the preset is never offered on an open deployment.
 */
export async function getServerSyncPreset(): Promise<SyncServerPreset> {
  if (!isAccessPasswordEnabled()) return UNAVAILABLE;

  const endpoint = env("SYNC_PRESET_S3_ENDPOINT");
  const bucket = env("SYNC_PRESET_S3_BUCKET");
  const accessKeyId = env("SYNC_PRESET_S3_ACCESS_KEY_ID");
  const secretAccessKey = env("SYNC_PRESET_S3_SECRET_ACCESS_KEY");
  const recoveryCode = env("SYNC_PRESET_RECOVERY_CODE");
  if (
    !endpoint ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !recoveryCode
  ) {
    return UNAVAILABLE;
  }

  const provider = S3ProviderSchema.safeParse({
    kind: "s3",
    endpoint,
    region: env("SYNC_PRESET_S3_REGION") || "auto",
    bucket,
    prefix: env("SYNC_PRESET_S3_PREFIX").replace(/^\/+|\/+$/g, ""),
    forcePathStyle:
      env("SYNC_PRESET_S3_FORCE_PATH_STYLE").toLowerCase() !== "false",
  });
  if (!provider.success) return UNAVAILABLE;

  try {
    await parseRecoveryCode(recoveryCode);
  } catch {
    return UNAVAILABLE;
  }

  return {
    available: true,
    provider: provider.data,
    credentials: { kind: "s3", accessKeyId, secretAccessKey },
    recoveryCode,
  };
}
