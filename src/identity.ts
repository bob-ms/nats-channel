// Session identity — the A2A `contextId` mapping (design-of-record:
// proposed/bob-ms/skills/design-fleet-hub-session-identity.md).
//
// The mapping is a dumb per-session file, `~/.claude/bobms/context-ids/<session_id>`
// → `ctx-…`. No daemon, no plane dependency, works offline. `resolveContextId`
// is the single precedence rule: env > persisted mapping > mint fresh.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MAPPING_DIR = join(homedir(), ".claude", "bobms", "context-ids");

function randomHex(nBytes: number): string {
  const bytes = new Uint8Array(nBytes);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a fresh A2A contextId: `ctx-` + 12–16 lowercase hex chars
 * (crypto-random, zero-dep). 7 bytes = 14 hex chars, mid the design's
 * 12–16 range — not the 8-hex `sess-`/`task-` shape used elsewhere on the
 * plane (too weak for a permanent join key; see design-of-record §Format).
 */
export function mintContextId(): string {
  return `ctx-${randomHex(7)}`;
}

export function mappingPath(sessionId: string, mappingDir: string = DEFAULT_MAPPING_DIR): string {
  return join(mappingDir, sessionId);
}

export function readMapping(
  sessionId: string,
  mappingDir: string = DEFAULT_MAPPING_DIR,
): string | undefined {
  try {
    const raw = readFileSync(mappingPath(sessionId, mappingDir), "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writeMapping(
  sessionId: string,
  contextId: string,
  mappingDir: string = DEFAULT_MAPPING_DIR,
): void {
  mkdirSync(mappingDir, { recursive: true });
  writeFileSync(mappingPath(sessionId, mappingDir), contextId, "utf8");
}

export type ResolveContextIdInput = {
  sessionId: string;
  /** `BOBMS_A2A_CONTEXT_ID` — set by the headless controller at spawn. */
  envContextId?: string;
  mappingDir?: string;
};

/**
 * Precedence: `BOBMS_A2A_CONTEXT_ID` env > persisted mapping > mint fresh.
 * Headless sessions adopt the controller's env-minted id (persisting it to
 * the mapping so later reads — including resume/compact — see the same
 * value). Interactive `source: startup` mints; `source: resume`/`compact`
 * naturally reuse via the mapping, since the session id is unchanged.
 * Forked/seeded sessions (new session id, no mapping) mint fresh — the
 * lens reconciliation absorbs the residual; this function stays dumb.
 */
export function resolveContextId(input: ResolveContextIdInput): string {
  const { sessionId, envContextId, mappingDir } = input;

  if (envContextId) {
    writeMapping(sessionId, envContextId, mappingDir);
    return envContextId;
  }

  const persisted = readMapping(sessionId, mappingDir);
  if (persisted) return persisted;

  const minted = mintContextId();
  writeMapping(sessionId, minted, mappingDir);
  return minted;
}
