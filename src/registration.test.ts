// Top-level end-to-end pure-core contract: a mapping file for a session →
// registration metadata built for that session carries `context_id`, read
// lazily and keyed by CLAUDE_CODE_SESSION_ID — never from the static
// per-user config.json (this module never touches it). This first test is
// the contract; roster consumers read `metadata` verbatim, so its shape
// here is what ends up on the roster row.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMapping } from "./identity";
import { buildServiceMetadata, fleetHost } from "./registration";

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
  test("carries the base fields roster consumers copy verbatim", () => {
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

describe("buildServiceMetadata — host field (BOB-409)", () => {
  test("carries the fleet host the registry surfaces per peer", () => {
    const metadata = buildServiceMetadata({
      owner: "rob",
      session: "hub-1",
      protocolVersion: "0.3",
      host: "vert",
    });

    expect(metadata.host).toBe("vert");
  });

  test("derives host from the environment when none is passed", () => {
    const metadata = buildServiceMetadata({
      owner: "rob",
      session: "hub-1",
      protocolVersion: "0.3",
    });

    expect(metadata.host).toBe(fleetHost());
    expect(metadata.host.length).toBeGreaterThan(0);
  });
});

describe("fleetHost — short fleet host derivation (BOB-409)", () => {
  const saved = process.env.BOBMS_HOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.BOBMS_HOST;
    else process.env.BOBMS_HOST = saved;
  });

  test("BOBMS_HOST overrides the OS hostname", () => {
    process.env.BOBMS_HOST = "blue";
    expect(fleetHost()).toBe("blue");
  });

  test("falls back to the OS hostname's first label", () => {
    delete process.env.BOBMS_HOST;
    expect(fleetHost()).not.toContain(".");
    expect(fleetHost().length).toBeGreaterThan(0);
  });
});
