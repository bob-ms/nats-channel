import { test, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { rmSync } from "node:fs";
import { DEFAULT_NAME_MAPPING_DIR, mappingPath, writeMapping } from "../src/identity";

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

const liveNameMappingSessionIds: string[] = [];
afterEach(() => {
  for (const sid of liveNameMappingSessionIds.splice(0)) {
    rmSync(mappingPath(sid, DEFAULT_NAME_MAPPING_DIR), { force: true });
  }
});

test("stamps session_name from the persisted name mapping", async () => {
  const sessionId = "test-session-name-mapping-bob464";
  liveNameMappingSessionIds.push(sessionId);
  writeMapping(sessionId, "minted-nanoid-name-x1", DEFAULT_NAME_MAPPING_DIR);

  const payload = { hook_event_name: "Stop", session_id: sessionId, cwd: `${HOME}/Projects/bob-ms/skills` };
  const env = { ...process.env };
  delete env.NATS_SESSION_NAME;
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "Stop"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const body = JSON.parse(stdout.slice(stdout.indexOf("\n") + 1).trim());
  expect(body.session_name).toBe("minted-nanoid-name-x1");
});

test("steward-injected NATS_SESSION_NAME outranks the persisted name mapping", async () => {
  const sessionId = "test-session-name-env-bob464";
  liveNameMappingSessionIds.push(sessionId);
  writeMapping(sessionId, "persisted-name", DEFAULT_NAME_MAPPING_DIR);

  const payload = { hook_event_name: "Stop", session_id: sessionId, cwd: `${HOME}/Projects/bob-ms/skills` };
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "Stop"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, NATS_SESSION_NAME: "steward-injected-name" },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const body = JSON.parse(stdout.slice(stdout.indexOf("\n") + 1).trim());
  expect(body.session_name).toBe("steward-injected-name");
});

test("omits session_name when neither env nor mapping exists", async () => {
  const payload = {
    hook_event_name: "Stop",
    session_id: "test-session-truly-unnamed",
    cwd: `${HOME}/Projects/bob-ms/skills`,
  };
  const env = { ...process.env };
  delete env.NATS_SESSION_NAME;
  const proc = Bun.spawn(["bun", SCRIPT, "--echo", "Stop"], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const body = JSON.parse(stdout.slice(stdout.indexOf("\n") + 1).trim());
  expect("session_name" in body).toBe(false);
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
