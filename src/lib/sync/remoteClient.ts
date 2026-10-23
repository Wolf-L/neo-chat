import { base64UrlToBytes, bytesToBase64Url } from "@/lib/byok/encoding";
import { encryptSecret, fetchWithByokRetry } from "@/lib/byok/client";
import { BYOK_CONTEXTS } from "@/lib/byok/shared";
import { readJsonResponseOrThrow, signedApiFetch } from "@/lib/api/client";
import { decryptLocalSecret } from "@/lib/security/localSecrets";
import type {
  SyncProviderConfig,
  SyncRemoteObjectMetadata,
  SyncRemoteRequest,
  SyncRemoteResponse,
} from "./types";
import type { LocalEncryptedSecretEnvelope } from "@/lib/security/localSecrets";

export const SYNC_REMOTE_LIST_MAX_PAGES = 256;
export const SYNC_REMOTE_LIST_MAX_OBJECTS = 100_000;

export interface SyncRemoteClient {
  test(signal?: AbortSignal): Promise<void>;
  list(
    prefix: string,
    signal?: AbortSignal,
  ): Promise<SyncRemoteObjectMetadata[]>;
  head(path: string, signal?: AbortSignal): Promise<SyncRemoteResponse>;
  get(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  put(
    path: string,
    bytes: Uint8Array,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export async function createSyncRemoteClient(
  provider: SyncProviderConfig,
  credentialSecret: LocalEncryptedSecretEnvelope,
): Promise<SyncRemoteClient> {
  const credentials = await decryptLocalSecret(
    credentialSecret,
    "local:sync:remote-credentials",
  );
  if (!credentials) throw new Error("Remote sync credentials are missing.");

  const request = async (
    input: Omit<SyncRemoteRequest, "provider" | "credentialSecret">,
    signal?: AbortSignal,
  ): Promise<SyncRemoteResponse> => {
    const response = await fetchWithByokRetry(async () => {
      const encrypted = await encryptSecret(
        credentials,
        BYOK_CONTEXTS.syncRemote,
        signal,
      );
      if (!encrypted) throw new Error("Remote sync credentials are missing.");
      return signedApiFetch("/api/sync/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          provider,
          credentialSecret: encrypted,
        } satisfies SyncRemoteRequest),
        signal,
      });
    });
    return readJsonResponseOrThrow<SyncRemoteResponse>(
      response,
      "Encrypted sync request failed",
    );
  };

  const throwIfListAborted = (signal?: AbortSignal): void => {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error("The sync object listing was aborted.");
    error.name = "AbortError";
    throw error;
  };

  return {
    async test(signal) {
      await request({ operation: "test" }, signal);
    },
    async list(prefix, signal) {
      const objects: SyncRemoteObjectMetadata[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        throwIfListAborted(signal);
        if (pageCount >= SYNC_REMOTE_LIST_MAX_PAGES) {
          throw new Error(
            `Encrypted sync object listing exceeded ${SYNC_REMOTE_LIST_MAX_PAGES} pages.`,
          );
        }
        if (cursor) seenCursors.add(cursor);
        const response = await request(
          { operation: "list", path: prefix, cursor },
          signal,
        );
        pageCount += 1;
        const pageObjects = response.objects || [];
        if (
          objects.length + pageObjects.length >
          SYNC_REMOTE_LIST_MAX_OBJECTS
        ) {
          throw new Error(
            `Encrypted sync object listing exceeded ${SYNC_REMOTE_LIST_MAX_OBJECTS} objects.`,
          );
        }
        objects.push(...pageObjects);
        if (
          response.cursor &&
          (response.cursor === cursor || seenCursors.has(response.cursor))
        ) {
          throw new Error(
            "Encrypted sync object listing returned a repeated cursor.",
          );
        }
        cursor = response.cursor;
      } while (cursor);
      return objects;
    },
    head(path, signal) {
      return request({ operation: "head", path }, signal);
    },
    async get(path, signal) {
      const response = await request({ operation: "get", path }, signal);
      if (typeof response.body !== "string") {
        throw new Error("Encrypted sync object response is missing a body.");
      }
      return base64UrlToBytes(response.body);
    },
    async put(path, bytes, contentType, signal) {
      await request(
        {
          operation: "put",
          path,
          body: bytesToBase64Url(bytes),
          contentType,
        },
        signal,
      );
    },
  };
}
