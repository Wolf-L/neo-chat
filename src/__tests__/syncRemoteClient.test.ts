import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/lib/api/client", async (importOriginal) => ({
  getResponseErrorMessage: (
    await importOriginal<typeof import("@/lib/api/client")>()
  ).getResponseErrorMessage,
  readJsonResponseOrThrow: mocks.readJsonResponseOrThrow,
  signedApiFetch: mocks.signedApiFetch,
}));

import {
  createSyncRemoteClient,
  SYNC_REMOTE_LIST_MAX_OBJECTS,
  SYNC_REMOTE_LIST_MAX_PAGES,
  SYNC_REMOTE_MAX_ATTEMPTS,
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

describe("encrypted sync remote client errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.decryptLocalSecret.mockResolvedValue(
      JSON.stringify({ kind: "s3", accessKeyId: "key", secretAccessKey: "s" }),
    );
    mocks.encryptSecret.mockResolvedValue({ ciphertext: "encrypted" });
    mocks.fetchWithByokRetry.mockImplementation(
      async (request: () => Promise<unknown>) => request(),
    );
    mocks.readJsonResponseOrThrow.mockImplementation(
      async (response: Response) => response.json(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const cpuLimitPage = () =>
    new Response("<html>Worker exceeded resource limits</html>", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    });

  it("retries transient platform failures", async () => {
    mocks.signedApiFetch
      .mockResolvedValueOnce(cpuLimitPage())
      .mockResolvedValueOnce(Response.json({ ok: true, exists: false }));
    const client = await createSyncRemoteClient(provider, credentialSecret);

    const result = client.head("objects/a");
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ ok: true, exists: false });
    expect(mocks.signedApiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.encryptSecret).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget with the HTTP status", async () => {
    mocks.signedApiFetch.mockImplementation(async () => cpuLimitPage());
    const client = await createSyncRemoteClient(provider, credentialSecret);

    const result = client.put("objects/a", new Uint8Array([1]));
    const assertion = expect(result).rejects.toThrow("HTTP 503");
    await vi.runAllTimersAsync();

    await assertion;
    expect(mocks.signedApiFetch).toHaveBeenCalledTimes(
      SYNC_REMOTE_MAX_ATTEMPTS,
    );
  });

  it("surfaces proxy errors instead of treating them as data", async () => {
    mocks.signedApiFetch.mockResolvedValue(
      Response.json(
        { error: "Remote put failed with HTTP 403." },
        { status: 400 },
      ),
    );
    const client = await createSyncRemoteClient(provider, credentialSecret);

    await expect(client.put("objects/a", new Uint8Array([1]))).rejects.toThrow(
      "Remote put failed with HTTP 403.",
    );
    expect(mocks.signedApiFetch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the caller aborts", async () => {
    const controller = new AbortController();
    mocks.signedApiFetch.mockImplementation(async () => {
      controller.abort();
      return cpuLimitPage();
    });
    const client = await createSyncRemoteClient(provider, credentialSecret);

    await expect(
      client.head("objects/a", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.signedApiFetch).toHaveBeenCalledTimes(1);
  });
});
