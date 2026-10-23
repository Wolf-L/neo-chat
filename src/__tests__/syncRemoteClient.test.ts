import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRemoteRequest, SyncRemoteResponse } from "@/lib/sync/types";

const mocks = vi.hoisted(() => ({
  decryptLocalSecret: vi.fn(),
  encryptSecret: vi.fn(),
  fetchWithByokRetry: vi.fn(),
  readJsonResponseOrThrow: vi.fn(),
  signedApiFetch: vi.fn(),
}));

vi.mock("@/lib/security/localSecrets", () => ({
  decryptLocalSecret: mocks.decryptLocalSecret,
}));
vi.mock("@/lib/byok/client", () => ({
  encryptSecret: mocks.encryptSecret,
  fetchWithByokRetry: mocks.fetchWithByokRetry,
}));
vi.mock("@/lib/api/client", () => ({
  readJsonResponseOrThrow: mocks.readJsonResponseOrThrow,
  signedApiFetch: mocks.signedApiFetch,
}));

import {
  createSyncRemoteClient,
  SYNC_REMOTE_LIST_MAX_OBJECTS,
  SYNC_REMOTE_LIST_MAX_PAGES,
} from "@/lib/sync/remoteClient";
import type { LocalEncryptedSecretEnvelope } from "@/lib/security/localSecrets";

const provider = {
  kind: "s3" as const,
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "vault",
  prefix: "neo-chat",
  forcePathStyle: true,
};
const credentialSecret = {} as LocalEncryptedSecretEnvelope;

async function makeClient(
  respond: (request: SyncRemoteRequest) => SyncRemoteResponse,
) {
  mocks.signedApiFetch.mockImplementation(
    async (_path: string, init: RequestInit) => {
      return respond(JSON.parse(String(init.body)) as SyncRemoteRequest);
    },
  );
  return createSyncRemoteClient(provider, credentialSecret);
}

describe("encrypted sync remote client pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decryptLocalSecret.mockResolvedValue(
      JSON.stringify({
        kind: "s3",
        accessKeyId: "key",
        secretAccessKey: "secret",
      }),
    );
    mocks.encryptSecret.mockResolvedValue({ ciphertext: "encrypted" });
    mocks.fetchWithByokRetry.mockImplementation(
      async (request: () => Promise<unknown>) => request(),
    );
    mocks.readJsonResponseOrThrow.mockImplementation(
      async (response: SyncRemoteResponse) => response,
    );
  });

  it("rejects cyclic cursors instead of requesting forever", async () => {
    let requestCount = 0;
    const client = await makeClient((request) => {
      requestCount += 1;
      const cursor =
        request.cursor === undefined
          ? "cursor-a"
          : request.cursor === "cursor-a"
            ? "cursor-b"
            : "cursor-a";
      return {
        ok: true,
        objects: [{ path: `objects/${requestCount}` }],
        cursor,
      };
    });

    await expect(client.list("objects")).rejects.toThrow("repeated cursor");
    expect(requestCount).toBe(3);
  });

  it("bounds the number of list pages", async () => {
    let requestCount = 0;
    const client = await makeClient(() => {
      requestCount += 1;
      return { ok: true, objects: [], cursor: `cursor-${requestCount}` };
    });

    await expect(client.list("objects")).rejects.toThrow(
      `exceeded ${SYNC_REMOTE_LIST_MAX_PAGES} pages`,
    );
    expect(requestCount).toBe(SYNC_REMOTE_LIST_MAX_PAGES);
  });

  it("bounds the total number of listed objects", async () => {
    const objects = Array.from(
      { length: SYNC_REMOTE_LIST_MAX_OBJECTS + 1 },
      (_, index) => ({ path: `objects/${index}` }),
    );
    const client = await makeClient(() => ({ ok: true, objects }));

    await expect(client.list("objects")).rejects.toThrow(
      `exceeded ${SYNC_REMOTE_LIST_MAX_OBJECTS} objects`,
    );
  });

  it("stops pagination when the caller aborts", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const client = await makeClient(() => {
      requestCount += 1;
      controller.abort();
      return { ok: true, objects: [], cursor: "next" };
    });

    await expect(
      client.list("objects", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requestCount).toBe(1);
  });
});
