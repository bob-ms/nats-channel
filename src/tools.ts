// The fleet-peer MCP tools (BOB-412, spawn added in BOB-473): `list_agents`,
// `prompt_agent`, and `spawn_agent`.
// Their definitions and dispatch live here, apart from `server.ts`, so they are
// unit-testable and provably registration-independent — they need only the live
// `nc`, never the plane registration. That independence is exactly what BOB-416's
// tools-only launch mode relies on: in no-register mode these stay fully wired
// while `svcm.add` is skipped. `server.ts` composes these with its `reply` tool.

import type { NatsConnection } from '@nats-io/transport-node'

import { listPeers, promptPeer, spawnAgent, type PeerIdentity } from './peers'

/** MCP tool definitions, returned as-is from the `list_tools` handler. */
export const PEER_TOOL_DEFS = [
  {
    name: 'list_agents',
    description:
      "List every other live peer on the fleet (fresh control-plane lookup): runtime, owner, name, host, and role. Controllers appear with role 'controller' and are not promptable.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'prompt_agent',
    description:
      'Prompt a named live peer and stream its reply back. Address by name; add owner and/or runtime to disambiguate. Controllers are not promptable.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The peer name to address (5th subject token).' },
        prompt: { type: 'string', description: 'The prompt text to send.' },
        owner: { type: 'string', description: 'Disambiguate by owner when the bare name is ambiguous.' },
        runtime: { type: 'string', description: 'Disambiguate by runtime: cc or pi.' },
        timeout_ms: { type: 'number', description: 'Max wait for the reply in ms (default 120000).' },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'spawn_agent',
    description:
      'Spawn a fresh peer session via a live steward controller: a new branch and worktree in the ' +
      'named repo, a bounded lifetime, and an immediately addressable child. The reply carries the ' +
      "child's session_id (its wire name) and prompt subject, so you can prompt_agent it right away. " +
      'Steward rejections (lifetime clamp, worktree claim conflict, spawn-token replay, in-progress ' +
      'conflict) surface verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'org/repo under the fleet checkout convention (~/repos/{org}/{repo}).' },
        prompt: { type: 'string', description: 'Initial prompt / slash command for the child session.' },
        base: { type: 'string', description: "Ancestry for the fresh branch (repo's default branch when omitted)." },
        model: { type: 'string', description: 'Optional model override for the child.' },
        max_lifetime_s: {
          type: 'number',
          description: 'Requested lifetime in seconds; steward-defaulted when omitted, ceiling-clamped when high.',
        },
        steward: {
          type: 'string',
          description: "Steward controller name (e.g. control-m3). Optional when exactly one controller is live.",
        },
        owner: { type: 'string', description: 'Disambiguate the steward by owner.' },
        runtime: { type: 'string', description: 'Disambiguate the steward by runtime: cc or pi.' },
        timeout_ms: { type: 'number', description: 'Max wait for the spawn reply in ms (default 150000).' },
      },
      required: ['repo', 'prompt'],
    },
  },
]

export type PeerToolDeps = {
  nc: NatsConnection
  /** Undefined in tools-only mode — self-exclusion is then a harmless no-op
   *  (there is no self on the plane to exclude). */
  instanceId?: string
  /** Caller identity stamped onto outbound prompts (audit stream). */
  sender: PeerIdentity
}

/** Whether `name` is one of the peer tools this module dispatches. */
export function isPeerTool(name: string): boolean {
  return name === 'list_agents' || name === 'prompt_agent' || name === 'spawn_agent'
}

/**
 * Dispatch a peer tool call to the runtime-agnostic peer ops. Throws for an
 * unknown tool name (the caller routes `reply` itself) and lets `listPeers` /
 * `promptPeer` errors propagate for the caller to surface to the model.
 */
export async function callPeerTool(
  name: string,
  args: Record<string, unknown>,
  deps: PeerToolDeps,
): Promise<{ text: string }> {
  switch (name) {
    case 'list_agents': {
      const rows = await listPeers(deps.nc, { excludeInstanceId: deps.instanceId })
      return { text: JSON.stringify(rows, null, 2) }
    }
    case 'prompt_agent': {
      const target = {
        name: args.name as string,
        owner: args.owner as string | undefined,
        runtime: args.runtime as string | undefined,
      }
      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined
      const { text } = await promptPeer(deps.nc, target, args.prompt as string, deps.sender, {
        timeoutMs,
      })
      return { text: text.length > 0 ? text : '(peer replied with no text)' }
    }
    case 'spawn_agent': {
      const target = {
        steward: args.steward as string | undefined,
        owner: args.owner as string | undefined,
        runtime: args.runtime as string | undefined,
      }
      const request = {
        repo: args.repo as string,
        prompt: args.prompt as string,
        base: args.base as string | undefined,
        model: args.model as string | undefined,
        maxLifetimeS: typeof args.max_lifetime_s === 'number' ? args.max_lifetime_s : undefined,
      }
      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined
      const { reply, promptSubject, spawnToken } = await spawnAgent(deps.nc, target, request, deps.sender, {
        timeoutMs,
      })
      return {
        text: JSON.stringify({ ...reply, prompt_subject: promptSubject, spawn_token: spawnToken }, null, 2),
      }
    }
    default:
      throw new Error(`not a peer tool: ${name}`)
  }
}
