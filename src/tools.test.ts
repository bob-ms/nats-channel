// The peer tools must stay registered and callable independent of plane
// registration — that independence is what BOB-416's tools-only mode relies on.
// The definitions are asserted purely; the dispatch is exercised against the
// same ephemeral `nats-server` scaffold as `peers.test.ts` (empty fleet +
// unknown peer), proving `callPeerTool` actually routes to the peer ops.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { connect, type NatsConnection } from '@nats-io/transport-node'

import { PEER_TOOL_DEFS, callPeerTool, isPeerTool, type PeerToolDeps } from './tools'

describe('PEER_TOOL_DEFS — registered tool surface', () => {
  test('exposes list_agents, prompt_agent, and spawn_agent with the expected shape', () => {
    const names = PEER_TOOL_DEFS.map((t) => t.name)
    expect(names).toEqual(['list_agents', 'prompt_agent', 'spawn_agent'])

    const promptAgent = PEER_TOOL_DEFS.find((t) => t.name === 'prompt_agent')!
    expect(promptAgent.inputSchema.required).toEqual(['name', 'prompt'])

    const spawnAgent = PEER_TOOL_DEFS.find((t) => t.name === 'spawn_agent')!
    expect(spawnAgent.inputSchema.required).toEqual(['repo', 'prompt'])
    expect(Object.keys(spawnAgent.inputSchema.properties)).toEqual(
      expect.arrayContaining(['repo', 'prompt', 'base', 'model', 'max_lifetime_s', 'steward', 'owner', 'runtime']),
    )
  })

  test('isPeerTool recognises the peer tools and nothing else', () => {
    expect(isPeerTool('list_agents')).toBe(true)
    expect(isPeerTool('prompt_agent')).toBe(true)
    expect(isPeerTool('spawn_agent')).toBe(true)
    expect(isPeerTool('reply')).toBe(false)
    expect(isPeerTool('nope')).toBe(false)
  })

  test('callPeerTool throws for a non-peer tool name', async () => {
    await expect(
      callPeerTool('reply', {}, {} as PeerToolDeps),
    ).rejects.toThrow(/not a peer tool/i)
  })
})

// ── Dispatch, exercised against a live ephemeral nats-server ────────────────

const SERVER_BIN = '/opt/homebrew/bin/nats-server'
const hasServer = (() => {
  try {
    if (Bun.file(SERVER_BIN).size >= 0) return true
  } catch {
    /* fall through to PATH lookup */
  }
  return !!Bun.which('nats-server')
})()

const PORT = 14823
const serverBin = (() => {
  try {
    if (Bun.file(SERVER_BIN).size >= 0) return SERVER_BIN
  } catch {
    /* fall through */
  }
  return Bun.which('nats-server') ?? 'nats-server'
})()

let serverProc: ReturnType<typeof Bun.spawn> | undefined
let nc: NatsConnection

async function waitForConnectable(url: string, attempts = 40): Promise<NatsConnection> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await connect({ servers: url, name: 'tools-test' })
    } catch (e) {
      lastErr = e
      await Bun.sleep(100)
    }
  }
  throw lastErr
}

const DEPS = (): PeerToolDeps => ({
  nc,
  sender: { runtime: 'cc', owner: 'rob', name: 'gsd-tools-test' },
})

describe.skipIf(!hasServer)('callPeerTool — dispatch against live NATS', () => {
  beforeAll(async () => {
    serverProc = Bun.spawn([serverBin, '-p', String(PORT), '-a', '127.0.0.1'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    nc = await waitForConnectable(`127.0.0.1:${PORT}`)
  })

  afterAll(async () => {
    try {
      await nc?.drain()
    } catch {
      /* ignore */
    }
    serverProc?.kill()
    await serverProc?.exited
  })

  test('list_agents on an empty fleet returns an empty JSON array', async () => {
    const { text } = await callPeerTool('list_agents', {}, DEPS())
    expect(JSON.parse(text)).toEqual([])
  })

  test('prompt_agent to an unknown peer surfaces a clear error', async () => {
    await expect(
      callPeerTool('prompt_agent', { name: 'nobody-here', prompt: 'x' }, DEPS()),
    ).rejects.toThrow(/unknown|unreachable|no live peer/i)
  })

  test('spawn_agent with no live steward surfaces a clear error', async () => {
    await expect(
      callPeerTool('spawn_agent', { repo: 'bob-ms/hub', prompt: 'go' }, DEPS()),
    ).rejects.toThrow(/no live steward/i)
  })
})
