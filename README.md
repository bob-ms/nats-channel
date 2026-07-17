# nats-channel

The owned NATS channel plugin — a Claude Code plugin that bridges NATS
messaging to a Claude Code session (Synadia Agent Protocol for NATS v0.3:
verb-first subjects, §7 query relay, §8.3 heartbeats) and mints/adopts the
session's A2A `contextId` at `SessionStart`, stamping it into the plane
registration metadata.

Sibling of `controllers/{pi,cc}` in this hub.
Ours-not-vendored (like the hub root `src/`) — seeded from the old skills-repo
roll with the synadia 0.4.0 improvements ported in; no upstream PR, never
enters the `vendored-patches` inventory.

## Layout

- `src/server.ts` — the ported MCP server: registers as an `agents` micro
  service, exposes `prompt`/`status` endpoints, relays permission prompts,
  publishes heartbeats.
- `src/identity.ts` — pure core: mint/read/write the per-session `contextId`
  mapping, `resolveContextId`'s env > mapping > mint precedence.
- `src/registration.ts` — pure core: builds the service `metadata` block
  (`buildServiceMetadata`), stamping `context_id` via a lazy per-session
  mapping read.
- `hooks/session-start.ts` — the `SessionStart` hook, the single minter of
  record for the session's `contextId`.
- `skills/configure/` — the `/nats-channel:configure` skill (context/owner/
  session-name/permissions).

## Session identity

Design-of-record: `proposed/bob-ms/skills/design-fleet-hub-session-identity.md`.

- The mapping is a dumb per-session file: `~/.claude/bobms/context-ids/<session_id>`
  → `ctx-<12-16 lowercase hex>`. No daemon, no plane dependency, works offline.
- Precedence: `BOBMS_A2A_CONTEXT_ID` env (headless controller's mint, adopted
  by the hook) > persisted mapping (interactive `resume`/`compact` reuse) >
  mint fresh (`startup`, or a forked/seeded session with no mapping).
- `server.ts` reads the mapping lazily, keyed by `CLAUDE_CODE_SESSION_ID`, at
  registration time — **not** from the static per-user `config.json`
  (`~/.claude/channels/nats/config.json`, see `config.example.json`), which
  is read once at boot and is structurally the wrong place for a per-session
  fact. Roster-fold copies the service `metadata` verbatim onto the
  `cc_sessions` row, so `context_id` surfaces as `metadata.context_id` with
  zero roster-fold change.

## Ops riders (manual, out of this slice)

- **Official plugin registration is a sudo managed-settings edit.** For a
  session to auto-load this plugin, it must be registered as an official
  plugin — that's a `managed-settings.json` edit requiring sudo. This
  component does not perform that edit; an operator does it once per host.
- **Infra `claude` wrappers need `--plugin-dir` + `--channel`.** The infra
  repo's wrapper scripts must add `--plugin-dir <path to this component>`
  and `--channel nats-channel` so wrapped sessions load the plugin. That
  infra-repo edit is **out of slice for this component** — flagged here as a
  manual follow-up, not performed by this component.

## Running standalone

```sh
bin/start   # exec bun src/server.ts
```

`NATS_CONTEXT` / `NATS_URL` env vars (or `/nats-channel:configure`) select
the broker; see `skills/configure/SKILL.md` for the full configuration
surface.
