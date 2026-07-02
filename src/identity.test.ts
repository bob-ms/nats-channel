import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintContextId, readMapping, resolveContextId, writeMapping } from "./identity";

describe("mintContextId", () => {
  test("returns ctx- + 12-16 lowercase hex chars", () => {
    for (let i = 0; i < 20; i++) {
      expect(mintContextId()).toMatch(/^ctx-[0-9a-f]{12,16}$/);
    }
  });

  test("mints are not deterministic", () => {
    expect(mintContextId()).not.toBe(mintContextId());
  });
});

let mappingDir: string;

beforeEach(() => {
  mappingDir = mkdtempSync(join(tmpdir(), "nats-channel-identity-"));
});

afterEach(() => {
  rmSync(mappingDir, { recursive: true, force: true });
});

describe("readMapping / writeMapping", () => {
  test("writeMapping then readMapping round-trips", () => {
    writeMapping("sess-1", "ctx-deadbeefdead", mappingDir);
    expect(readMapping("sess-1", mappingDir)).toBe("ctx-deadbeefdead");
  });

  test("readMapping returns undefined when no mapping file exists", () => {
    expect(readMapping("no-such-session", mappingDir)).toBeUndefined();
  });
});

describe("resolveContextId — precedence: env > persisted mapping > mint fresh", () => {
  test("env var wins even when a mapping already exists", () => {
    writeMapping("sess-1", "ctx-existingexist", mappingDir);

    const id = resolveContextId({
      sessionId: "sess-1",
      envContextId: "ctx-fromenvfromenv",
      mappingDir,
    });

    expect(id).toBe("ctx-fromenvfromenv");
  });

  test("env var adoption persists to the mapping (headless controller minted it, hook adopts)", () => {
    resolveContextId({
      sessionId: "sess-1",
      envContextId: "ctx-fromenvfromenv",
      mappingDir,
    });

    expect(readMapping("sess-1", mappingDir)).toBe("ctx-fromenvfromenv");
  });

  test("source: resume with an existing mapping reuses it — no re-mint", () => {
    writeMapping("sess-1", "ctx-existingexist", mappingDir);

    const id = resolveContextId({ sessionId: "sess-1", mappingDir });

    expect(id).toBe("ctx-existingexist");
  });

  test("source: startup with no mapping mints fresh and persists it", () => {
    const id = resolveContextId({ sessionId: "sess-2", mappingDir });

    expect(id).toMatch(/^ctx-[0-9a-f]{12,16}$/);
    expect(readMapping("sess-2", mappingDir)).toBe(id);
  });

  test("forked/seeded session (new session id, no mapping) mints fresh without crashing", () => {
    const id = resolveContextId({ sessionId: "forked-session-id", mappingDir });
    expect(id).toMatch(/^ctx-[0-9a-f]{12,16}$/);
  });
});
