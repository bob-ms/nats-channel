// The two fleet-peer MCP tools (BOB-412): `list_agents` and `prompt_agent`.
// Their definitions and dispatch live here, apart from `server.ts`, so they are
// unit-testable and provably registration-independent — they need only the live
// `nc`, never the plane registration. That independence is exactly what BOB-416's
// tools-only launch mode relies on: in no-register mode these stay fully wired
// while `svcm.add` is skipped. `server.ts` composes these with its `reply` tool.

import type { NatsConnection } from '@nats-io/transport-node'

import { listPeers, promptPeer, type PeerIdentity } from './peers'

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
  return name === 'list_agents' || name === 'prompt_agent'
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
    default:
      throw new Error(`not a peer tool: ${name}`)
  }
}
