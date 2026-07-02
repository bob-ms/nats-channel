import { test, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { rmSync } from "node:fs";
import { mappingPath, writeMapping } from "../src/identity";

const SCRIPT = `${import.meta.dir}/nats-session-event.ts`;
const HOME = homedir();

// Moved from the skills repo (bob-260) — extended with the context_id/task_id
// stamp assertions below. The subject-derivation + verbatim-passthrough
// behaviour (absent a mapping) is the inherited invariant.

test("PostToolUse: subject derivation + verbatim passthrough when no mapping exists", async () => {
  const payload = {
    hook_event_name: "PostToolUse",
    session_id: "test-session-abc123-no-mapping",
    cwd: `${HOME}/Projects/bob-ms/skills`,
    transcript_path: `${HOME}/.claude/transcripts/test-session-abc123.jsonl`,
    prompt: "A".repeat(250),
    tool_response: { tool_name: "Bash", result: "ls -la", exit_code: 0 },
  };

  const input = JSON.stringify(payload);
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "PostToolUse"], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const newline = stdout.indexOf("\n");
  const subject = stdout.slice(0, newline);
  const body = stdout.slice(newline + 1).trim();

  expect(subject).toBe("agent.session.cc.tool.bob-ms.skills");
  expect(JSON.parse(body)).toEqual(payload);
});

// The emitter reads the real default mapping dir (~/.claude/bobms/context-ids)
// — same as session-start.ts's minter — so this test writes/cleans up a real
// mapping file under a nonce session id rather than faking the dir.
const liveMappingSessionIds: string[] = [];
afterEach(() => {
  for (const sid of liveMappingSessionIds.splice(0)) {
    rmSync(mappingPath(sid), { force: true });
  }
});

test("stamps context_id read from the mapping onto the published body", async () => {
  const sessionId = "test-session-with-mapping-bob260";
  liveMappingSessionIds.push(sessionId);
  writeMapping(sessionId, "ctx-abc123def456");

  const payload = { hook_event_name: "Stop", session_id: sessionId, cwd: `${HOME}/Projects/bob-ms/skills` };
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "Stop"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const newline = stdout.indexOf("\n");
  const body = JSON.parse(stdout.slice(newline + 1).trim());

  expect(body.context_id).toBe("ctx-abc123def456");
});

test("omits context_id cleanly when no mapping exists — never throws, never an empty field", async () => {
  const payload = {
    hook_event_name: "Notification",
    session_id: "test-session-truly-unmapped",
    cwd: `${HOME}/Projects/bob-ms/skills`,
  };
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "Notification"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  expect(exitCode).toBe(0);
  const newline = stdout.indexOf("\n");
  const body = JSON.parse(stdout.slice(newline + 1).trim());
  expect(body.context_id).toBeUndefined();
  expect("context_id" in body).toBe(false);
});

test("stamps task_id from BOBMS_A2A_TASK_ID env when present", async () => {
  const payload = {
    hook_event_name: "Stop",
    session_id: "test-session-taskid",
    cwd: `${HOME}/Projects/bob-ms/skills`,
  };
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "Stop"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, BOBMS_A2A_TASK_ID: "task-deadbeef01" },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const newline = stdout.indexOf("\n");
  const body = JSON.parse(stdout.slice(newline + 1).trim());
  expect(body.task_id).toBe("task-deadbeef01");
});

test("omits task_id when BOBMS_A2A_TASK_ID is unset", async () => {
  const payload = {
    hook_event_name: "Stop",
    session_id: "test-session-no-taskid",
    cwd: `${HOME}/Projects/bob-ms/skills`,
  };
  const env = { ...process.env };
  delete env.BOBMS_A2A_TASK_ID;
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "Stop"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const newline = stdout.indexOf("\n");
  const body = JSON.parse(stdout.slice(newline + 1).trim());
  expect("task_id" in body).toBe(false);
});
