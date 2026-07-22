// Plane registration metadata — the seam that stamps `context_id` onto the
// service `metadata` block `server.ts` hands to `svcm.add`. Roster consumers
// copy `metadata` verbatim, so adding `context_id` here surfaces it as
// `metadata.context_id` with zero consumer change.
//
// The read is lazy and per-session (keyed by `CLAUDE_CODE_SESSION_ID`) — it
// never touches the static per-user `config.json`, which is read once at
// boot and structurally wrong for a per-session fact (design-of-record §3).

import { hostname } from "node:os";

import { readMapping } from "./identity";

export type ServiceMetadata = {
  agent: string;
  owner: string;
  session: string;
  protocol_version: string;
  /** Fleet host this session runs on — the qualified peer's location. */
  host: string;
  context_id?: string;
};

export type BuildServiceMetadataInput = {
  owner: string;
  session: string;
  protocolVersion: string;
  agent?: string;
  /** `CLAUDE_CODE_SESSION_ID` — the key for the lazy per-session mapping read. */
  sessionId?: string;
  mappingDir?: string;
  /** Override the derived fleet host — tests pass a fixed value. */
  host?: string;
};

/**
 * The short fleet host name a peer runs on (`m3`, `vert`, `blue`, `red`) —
 * `BOBMS_HOST` when set, else the OS hostname's first label. Every registration
 * path in this split derives its host the same way so the registry answers a
 * uniform `host` field across runtimes.
 */
export function fleetHost(): string {
  const override = process.env.BOBMS_HOST;
  if (override && override.length > 0) return override;
  return hostname().split(".")[0] ?? hostname();
}

export function buildServiceMetadata(input: BuildServiceMetadataInput): ServiceMetadata {
  const { owner, session, protocolVersion, agent = "claude-code", sessionId, mappingDir, host } = input;

  const metadata: ServiceMetadata = {
    agent,
    owner,
    session,
    protocol_version: protocolVersion,
    host: host ?? fleetHost(),
  };

  if (sessionId) {
    const contextId = readMapping(sessionId, mappingDir);
    if (contextId) metadata.context_id = contextId;
  }

  return metadata;
}
