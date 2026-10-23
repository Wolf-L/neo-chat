import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATED_ROUTE, applyCustomizations, parseJsonc } from "../apply.mjs";

const WRANGLER = `{
  // comment with "quotes", and a trailing comma,
  "name": "neo-chat",
  "url": "https://example.com/*not-a-comment*/",
  /* block */ "vars": { "DEPLOYMENT_MODE": "hosted", },
}
`;

describe("custom overlay apply", () => {
  let root = "";

  function write(path: string, source: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "neo-chat-overlay-"));
    write("src/lib/sync/scheduler.ts", "export const upstream = true;\n");
    write(
      "src/components/sync/SyncLifecycle.tsx",
      'import { startEncryptedSyncScheduler } from "@/lib/sync/scheduler";\n',
    );
    write(
      "src/__tests__/syncScheduler.test.ts",
      'import { startEncryptedSyncScheduler } from "@/lib/sync/scheduler";\n',
    );
    write("src/__tests__/other.test.ts", 'import "@/lib/sync/crypto";\n');
    write("wrangler.jsonc", WRANGLER);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("parses JSONC without touching strings", () => {
    expect(parseJsonc(WRANGLER)).toEqual({
      name: "neo-chat",
      url: "https://example.com/*not-a-comment*/",
      vars: { DEPLOYMENT_MODE: "hosted" },
    });
  });

  it("injects the overlay, route, and deployment routes", () => {
    const result = applyCustomizations(root);

    expect(result.copied).toEqual(
      expect.arrayContaining([
        "src/lib/sync/scheduler.ts",
        "src/lib/sync/customPreset.ts",
        "src/lib/sync/customServerPreset.ts",
      ]),
    );
    expect(
      readFileSync(join(root, "src/lib/sync/scheduler.ts"), "utf8"),
    ).toContain("SYNC_AFTER_RESPONSE_DELAY_MS");
    expect(readFileSync(join(root, GENERATED_ROUTE), "utf8")).toContain(
      "@/lib/sync/customServerPreset",
    );
    expect(result.wiredBy).toEqual(["src/components/sync/SyncLifecycle.tsx"]);
    expect(result.removedTests).toEqual([
      "src/__tests__/syncScheduler.test.ts",
    ]);
    expect(existsSync(join(root, "src/__tests__/other.test.ts"))).toBe(true);

    const wrangler = JSON.parse(
      readFileSync(join(root, "wrangler.jsonc"), "utf8"),
    );
    expect(wrangler.vars).toEqual({ DEPLOYMENT_MODE: "hosted" });
    expect(wrangler.workers_dev).toBe(true);
    expect(wrangler.routes).toContainEqual({
      pattern: "chat.qqedu.ccwu.cc",
      custom_domain: true,
    });
  });

  it("fails before copying when upstream ships an overlay file", () => {
    write("src/lib/sync/customPreset.ts", "export {};\n");

    expect(() => applyCustomizations(root)).toThrow(/customPreset\.ts/);
    expect(
      readFileSync(join(root, "src/lib/sync/scheduler.ts"), "utf8"),
    ).toContain("upstream");
  });

  it("fails when upstream drops the overridden scheduler", () => {
    rmSync(join(root, "src/lib/sync/scheduler.ts"));

    expect(() => applyCustomizations(root)).toThrow(/no longer ships/);
  });

  it("fails when upstream stops starting the scheduler", () => {
    write("src/components/sync/SyncLifecycle.tsx", "export {};\n");

    expect(() => applyCustomizations(root)).toThrow(/startEncryptedSync/);
  });
});
