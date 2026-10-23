// Fork overlay: server side of the server-managed sync vault. Served from
// `/api/sync/custom-preset` by the route `custom/apply.mjs` generates.
import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAccessPasswordEnabled } from "@/lib/security/accessControl";
import { parseRecoveryCode } from "@/lib/sync/crypto";
import type { SyncServerPreset } from "./customPreset";

const UNAVAILABLE: SyncServerPreset = { available: false };

const S3ProviderSchema = z
  .object({
    kind: z.literal("s3"),
    endpoint: z.string().url().max(2_048),
    region: z.string().trim().min(1).max(100),
    bucket: z.string().trim().min(1).max(255),
    prefix: z
      .string()
      .max(2_048)
      .refine(
        (value) =>
          !value.includes("\\") &&
          value
            .split("/")
            .every((segment) => segment !== "." && segment !== ".."),
      ),
    forcePathStyle: z.boolean(),
  })
  .strict();

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

export async function GET() {
  return NextResponse.json(await getServerSyncPreset(), {
    headers: { "Cache-Control": "no-store" },
  });
}
