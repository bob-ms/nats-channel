#!/usr/bin/env bun
// SessionStart hook — the single minter of record for the session's A2A
// contextId (design-of-record: proposed/bob-ms/skills/design-fleet-hub-session-identity.md
// §Minting). Rides this plugin so minter and roster-stamper (server.ts,
// via registration.ts) ship as one component.
//
// Precedence: BOBMS_A2A_CONTEXT_ID env (headless controller adoption) >
// persisted mapping (source: resume/compact reuse) > mint fresh
// (source: startup, or a forked/seeded session with no mapping).
//
// Hard rule shared with the skills-repo session-event emitter: this must
// never break a session. Best-effort, bounded, always exits 0.

import { resolveContextId, resolveSessionNanoid } from "../src/identity";

type SessionStartInput = {
  session_id?: string;
  source?: string;
  hook_event_name?: string;
};

try {
  const raw = await Bun.stdin.text().catch(() => "");
  let payload: SessionStartInput = {};
  try {
    payload = raw ? (JSON.parse(raw) as SessionStartInput) : {};
  } catch {
    payload = {};
  }

  const sessionId = payload.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId) {
    resolveContextId({
      sessionId,
      envContextId: process.env.BOBMS_A2A_CONTEXT_ID,
    });
    resolveSessionNanoid({
      sessionId,
      envSessionName: process.env.NATS_SESSION_NAME,
    });
  }
} catch (err) {
  process.stderr.write(`nats-channel session-start hook: ${err}\n`);
}

process.exit(0);
