// Plane registration metadata — the seam that stamps `context_id` onto the
// service `metadata` block `server.ts` hands to `svcm.add`. `roster-fold.ts`
// (root `src/roster-fold.ts`) copies `metadata` verbatim onto the `cc_sessions`
// roster row, so adding `context_id` here surfaces it as `metadata.context_id`
// with zero roster-fold change.
//
// The read is lazy and per-session (keyed by `CLAUDE_CODE_SESSION_ID`) — it
// never touches the static per-user `config.json`, which is read once at
// boot and structurally wrong for a per-session fact (design-of-record §3).

import { readMapping } from "./identity";

export type ServiceMetadata = {
  agent: string;
  owner: string;
  session: string;
  protocol_version: string;
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
};

export function buildServiceMetadata(input: BuildServiceMetadataInput): ServiceMetadata {
  const { owner, session, protocolVersion, agent = "claude-code", sessionId, mappingDir } = input;

  const metadata: ServiceMetadata = {
    agent,
    owner,
    session,
    protocol_version: protocolVersion,
  };

  if (sessionId) {
    const contextId = readMapping(sessionId, mappingDir);
    if (contextId) metadata.context_id = contextId;
  }

  return metadata;
}
