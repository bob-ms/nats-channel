// Top-level end-to-end pure-core contract: a mapping file for a session →
// registration metadata built for that session carries `context_id`, read
// lazily and keyed by CLAUDE_CODE_SESSION_ID — never from the static
// per-user config.json (this module never touches it). This first test is
// the contract; the roster-fold consumes `metadata` verbatim, so its shape
// here is what ends up on the roster row.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMapping } from "./identity";
import { buildServiceMetadata } from "./registration";

let mappingDir: string;

beforeEach(() => {
  mappingDir = mkdtempSync(join(tmpdir(), "nats-channel-registration-"));
});

afterEach(() => {
  rmSync(mappingDir, { recursive: true, force: true });
});

describe("buildServiceMetadata — end-to-end contract", () => {
  test("mapping file for session S carrying ctx-abc… produces metadata.context_id === that id", () => {
    writeMapping("S", "ctx-abc123abc123", mappingDir);

    const metadata = buildServiceMetadata({
      owner: "rob",
      session: "hub-1",
      protocolVersion: "0.3",
      sessionId: "S",
      mappingDir,
    });

    expect(metadata.context_id).toBe("ctx-abc123abc123");
  });
});

describe("buildServiceMetadata — inner cases", () => {
  test("carries the base fields the roster-fold copies verbatim", () => {
    const metadata = buildServiceMetadata({
      owner: "rob",
      session: "hub-1",
      protocolVersion: "0.3",
    });

    expect(metadata.agent).toBe("claude-code");
    expect(metadata.owner).toBe("rob");
    expect(metadata.session).toBe("hub-1");
    expect(metadata.protocol_version).toBe("0.3");
  });

  test("mapping absent → no context_id key at all (degrade visible, never invented)", () => {
    const metadata = buildServiceMetadata({
      owner: "rob",
      session: "hub-1",
      protocolVersion: "0.3",
      sessionId: "no-such-session",
      mappingDir,
    });

    expect("context_id" in metadata).toBe(false);
  });

  test("no sessionId given → never reads the mapping, no context_id key", () => {
    writeMapping("S", "ctx-abc123abc123", mappingDir);

    const metadata = buildServiceMetadata({
      owner: "rob",
      session: "hub-1",
      protocolVersion: "0.3",
      mappingDir,
    });

    expect("context_id" in metadata).toBe(false);
  });
});
