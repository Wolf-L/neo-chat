import type { EncryptedSecretEnvelope } from "@/lib/byok/shared";
import type { LocalEncryptedSecretEnvelope } from "@/lib/security/localSecrets";

export const SYNC_FORMAT_VERSION = 1 as const;
export const SYNC_CHUNK_BYTES = 4 * 1024 * 1024;

export type SyncProviderConfig =
  | {
      kind: "webdav";
      baseUrl: string;
      rootPath: string;
    }
  | {
      kind: "s3";
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      forcePathStyle: boolean;
    };

export type SyncProviderCredentials =
  | {
      kind: "webdav";
      username: string;
      password: string;
    }
  | {
      kind: "s3";
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };

export type SyncDocumentKind =
  | "root"
  | "core-settings"
  | "settings"
  | "chat-meta"
  | "workspace"
  | "session"
  | "session-messages"
  | "knowledge-meta"
  | "knowledge-collection"
  | "memory"
  | "opfs-manifest";

export interface SyncDocumentDescriptor {
  id: string;
  kind: SyncDocumentKind;
  deleted?: boolean;
  updatedAt: string;
}

export interface SyncDevice {
  id: string;
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SyncDocumentIndex {
  formatVersion: typeof SYNC_FORMAT_VERSION;
  vaultId: string;
  documents: Record<string, SyncDocumentDescriptor>;
  devices: Record<string, SyncDevice>;
}

export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | SyncJsonValue[]
  | { [key: string]: SyncJsonValue };

export interface SyncCrdtDocument extends Record<string, unknown> {
  formatVersion: typeof SYNC_FORMAT_VERSION;
  logicalId: string;
  kind: SyncDocumentKind;
  payload: Record<string, SyncJsonValue>;
}

export interface SyncConflict {
  id: string;
  documentId: string;
  path: string[];
  currentValue: SyncJsonValue | undefined;
  values: SyncJsonValue[];
}

export interface EncryptedSyncObject {
  formatVersion: typeof SYNC_FORMAT_VERSION;
  algorithm: "A256GCM";
  iv: string;
  aad: string;
  ciphertext: string;
  plaintextBytes: number;
}

export interface SyncBlobChunk {
  index: number;
  objectPath: string;
  sha256: string;
  plaintextBytes: number;
}

export interface SyncBlobManifestEntry {
  url: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunks: SyncBlobChunk[];
}

export type SyncStatus =
  | "disabled"
  | "idle"
  | "syncing"
  | "up-to-date"
  | "offline"
  | "conflict"
  | "error";

export interface SyncRemoteRequest {
  operation: "test" | "list" | "head" | "get" | "put";
  provider: SyncProviderConfig;
  credentialSecret: EncryptedSecretEnvelope;
  path?: string;
  cursor?: string;
  body?: string;
  contentType?: string;
}

export interface SyncRemoteObjectMetadata {
  path: string;
  size?: number;
  etag?: string;
  lastModified?: string;
}

export interface SyncRemoteResponse {
  ok: true;
  objects?: SyncRemoteObjectMetadata[];
  cursor?: string;
  exists?: boolean;
  body?: string;
  size?: number;
  etag?: string;
  contentType?: string;
}

export interface PersistedSyncConfiguration {
  enabled: boolean;
  provider?: SyncProviderConfig;
  credentialSecret?: LocalEncryptedSecretEnvelope;
  rootKeySecret?: LocalEncryptedSecretEnvelope;
  vaultId?: string;
  deviceName: string;
  lastSyncAt?: string;
  lastSyncBytes?: number;
}

export interface SyncRunConfiguration extends PersistedSyncConfiguration {
  provider: SyncProviderConfig;
  credentialSecret: LocalEncryptedSecretEnvelope;
  rootKeySecret: LocalEncryptedSecretEnvelope;
  vaultId: string;
}

export interface SyncRunResult {
  changed: boolean;
  uploadedBytes: number;
  downloadedBytes: number;
  devices: SyncDevice[];
  conflicts: SyncConflict[];
}
