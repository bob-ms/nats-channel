#!/usr/bin/env bun
// Session-event hook: publish a Claude Code session lifecycle event onto NATS,
// so a watcher can keep an eye on the whole fleet without anyone polling.
//
// Rides this plugin alongside the SessionStart minter (session-start.ts) so the
// id source and its stamp ship as one component. This is the live session-event
// emitter of record: loaded into every session via claude-wrapper's --plugin-dir,
// it publishes on the unified `cc` token. The old skills-repo copy (which
// published the legacy `claude` token) has been retired — this plugin is its home.
//
// Wired in hooks.json to UserPromptSubmit, PostToolUse, Notification, Stop,
// SubagentStop, SessionStart and SessionEnd — each invocation passes its event
// name as the first argument.
//
//   subject:  agent.session.<runtime>.<event>.<project>   (runtime = cc here)
//     event   = neutral lifecycle verb (open | start | tool | waiting | idle | child_end | end)
//     project = cwd → <org>.<repo>, worktrunk ".branch" suffix stripped, else cwd basename
//   watch:    nats sub 'agent.session.>'
//
// We shell out to the `nats` CLI rather than the native client: zero npm deps,
// no connection lifecycle, and the publisher stays in the bun/TS stack that the
// rest of the mesh (nats-channel) and the eventual watcher live in.
//
// Hard rule: observability must never break a session. Best-effort publish with
// a bounded timeout; emits nothing on stdout and always exits 0.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { readMapping } from "../src/identity";

const NATS_BIN =
  ["/opt/homebrew/bin/nats", "/usr/local/bin/nats", "/usr/bin/nats"].find(existsSync) ?? "nats";
const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const RUNTIME = "cc"; // this emitter is Claude Code (cc token); the pi adapter sets "pi"

// Map Claude's hook event names onto neutral, harness-agnostic lifecycle verbs.
const EVENT_ALIASES: Record<string, string> = {
  userpromptsubmit: "start",
  notification: "waiting",
  stop: "idle",
  subagentstop: "child_end",
  sessionend: "end",
  sessionstart: "open",
  posttooluse: "tool",
};

function normEvent(raw?: string): string {
  const k = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return EVENT_ALIASES[k] ?? (k || "unknown");
}

// ~/Projects/<org>/<repo>[/<worktree>] → <org>.<repo>; worktrunk ".branch" decoration dropped.
function projectFor(cwd?: string): string {
  if (!cwd) return "unknown";
  const prefix = `${homedir()}/Projects/`;
  if (cwd.startsWith(prefix)) {
    const [org, repoRaw] = cwd.slice(prefix.length).split("/");
    const repo = repoRaw?.split(".")[0];
    return [org, repo].filter(Boolean).join(".") || basename(cwd);
  }
  return basename(cwd);
}

// --- self-test (no stdin) -------------------------------------------------
if (process.argv.includes("--test")) {
  const home = homedir();
  let fail = 0;
  const check = (label: string, got: string, want: string) => {
    const ok = got === want;
    if (!ok) fail++;
    console.error(`${ok ? "PASS" : "FAIL"}: ${label} → ${got}${ok ? "" : ` (want ${want})`}`);
  };
  check("project bob-ms/skills", projectFor(`${home}/Projects/bob-ms/skills`), "bob-ms.skills");
  check("project ytb worktree", projectFor(`${home}/Projects/ytb/web-app/ytb-web-app-main`), "ytb.web-app");
  check("project .branch strip", projectFor(`${home}/Projects/bob-ms/skills.feat-x`), "bob-ms.skills");
  check("project non-Projects", projectFor("/tmp/whatever"), "whatever");
  for (const [raw, want] of [
    ["UserPromptSubmit", "start"],
    ["Notification", "waiting"],
    ["Stop", "idle"],
    ["SubagentStop", "child_end"],
    ["SessionEnd", "end"],
    ["PostToolUse", "tool"],
  ] as const) {
    check(`event ${raw}`, normEvent(raw), want);
  }
  process.exit(fail ? 1 : 0);
}

// --- build the event ------------------------------------------------------
const echo = process.argv.includes("--echo");
const argEvent = process.argv.slice(2).find((a) => !a.startsWith("--"));

const raw = await Bun.stdin.text().catch(() => "");
let payload: Record<string, any> = {};
try {
  payload = raw ? JSON.parse(raw) : {};
} catch {
  payload = {};
}

const event = normEvent(argEvent ?? payload.hook_event_name);
const cwd: string = payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const project = projectFor(cwd);

const subject = `agent.session.${RUNTIME}.${event}.${project}`;

// Stamp context_id (+ task_id where present) onto the published body — the
// producer half of the identity chain (session-start.ts mints/persists the
// mapping; this reads it back). Best-effort: no mapping yet (a stray event
// racing the minter, or a harness with no session_id) omits the field cleanly
// rather than throwing — matches the emitter's never-break-a-session rule.
const sessionId: string | undefined = payload.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
const contextId = sessionId ? readMapping(sessionId) : undefined;
const taskId = process.env.BOBMS_A2A_TASK_ID;

const body: Record<string, any> = { ...payload };
if (contextId) body.context_id = contextId;
if (taskId) body.task_id = taskId;
const outRaw = JSON.stringify(body);

if (echo) {
  console.log(subject);
  console.log(outRaw);
  process.exit(0);
}

// --- publish (best-effort, bounded, never fatal) --------------------------
try {
  const child = Bun.spawn([NATS_BIN, "pub", "-s", NATS_URL, subject, outRaw], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  const guard = setTimeout(() => child.kill(), 1500);
  await child.exited;
  clearTimeout(guard);
} catch {
  // swallow — a watcher being down must never break a working session
}

process.exit(0);
