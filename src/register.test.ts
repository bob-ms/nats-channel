// The registration guard is the whole point of BOB-416's tools-only launch
// mode: `NATS_NO_REGISTER` must make `registerAgent` skip `svcm.add` entirely,
// while the default path registers exactly as before. Driven against a spy
// service manager — no live NATS needed — so the guard is provable in isolation.

import { describe, expect, test } from 'bun:test'
import { AgentSubject, SERVICE_NAME } from '@synadia-ai/agents'
import { buildHeartbeatPayload, encodeHeartbeatPayload } from '@synadia-ai/agent-service'
import type { ServiceMsg } from '@nats-io/services'

import {
  registerAgent,
  type RegisterAgentOptions,
  type ServiceLike,
  type ServiceManagerLike,
} from './register'
import { deriveHarnessIdentity } from './registration'

function makeSpySvcm() {
  const addConfigs: Array<Record<string, unknown>> = []
  const endpoints: string[] = []
  const service: ServiceLike = {
    addEndpoint: (name) => {
      endpoints.push(name)
    },
    info: () => ({ id: 'inst-xyz' }),
    stop: async () => {},
  }
  const svcm: ServiceManagerLike = {
    add: async (cfg) => {
      addConfigs.push(cfg as Record<string, unknown>)
      return service
    },
  }
  return { svcm, addConfigs, endpoints }
}

function makeOpts(overrides: Partial<RegisterAgentOptions>): {
  opts: RegisterAgentOptions
  publishes: Array<{ subject: string }>
} {
  const publishes: Array<{ subject: string }> = []
  const opts: RegisterAgentOptions = {
    noRegister: false,
    nc: { publish: (subject: string) => void publishes.push({ subject }) },
    serviceName: SERVICE_NAME,
    version: '9.9.9',
    description: 'Claude Code — test',
    metadata: { agent: 'claude-code', owner: 'rob' },
    promptSubject: 'agents.prompt.cc.rob.test',
    promptQueue: 'prompt-q',
    promptMetadata: { max_payload: '1MB' },
    statusSubject: 'agents.status.cc.rob.test',
    statusQueue: 'status-q',
    heartbeatSubject: 'agents.hb.cc.rob.test',
    heartbeatIntervalMs: 5000,
    onPrompt: () => {},
    buildHeartbeat: () => new Uint8Array([1, 2, 3]),
    ...overrides,
  }
  return { opts, publishes }
}

describe('registerAgent — NATS_NO_REGISTER guard (BOB-416)', () => {
  test('noRegister → zero svcm.add, no endpoints, no heartbeat, returns null', async () => {
    const { svcm, addConfigs, endpoints } = makeSpySvcm()
    const { opts, publishes } = makeOpts({ noRegister: true, svcm })

    const result = await registerAgent(opts)

    expect(result).toBeNull()
    expect(addConfigs.length).toBe(0)
    expect(endpoints).toEqual([])
    expect(publishes.length).toBe(0)
  })

  test('default (noRegister=false) → registers via svcm.add + prompt/status endpoints, heartbeats', async () => {
    const { svcm, addConfigs, endpoints } = makeSpySvcm()
    const { opts, publishes } = makeOpts({ noRegister: false, svcm })

    const result = await registerAgent(opts)

    expect(result).not.toBeNull()
    expect(addConfigs.length).toBe(1)
    expect(addConfigs[0]!.name).toBe(SERVICE_NAME)
    expect(endpoints).toEqual(['prompt', 'status'])
    expect(result!.instanceId).toBe('inst-xyz')
    // An immediate heartbeat is published on connect, before the interval.
    expect(publishes.some((p) => p.subject === 'agents.hb.cc.rob.test')).toBe(true)

    clearInterval(result!.heartbeatTimer)
  })

  test('alias set → adds prompt-alias/status-alias endpoints; heartbeat stays canonical-only', async () => {
    const { svcm, endpoints } = makeSpySvcm()
    const { opts, publishes } = makeOpts({
      svcm,
      alias: {
        promptSubject: 'agents.prompt.cc.rob.old-cwd-name',
        statusSubject: 'agents.status.cc.rob.old-cwd-name',
      },
    })

    const result = await registerAgent(opts)

    expect(endpoints).toEqual(['prompt', 'status', 'prompt-alias', 'status-alias'])
    expect(publishes.every((p) => p.subject === 'agents.hb.cc.rob.test')).toBe(true)

    clearInterval(result!.heartbeatTimer)
  })

  test('no alias → endpoints unchanged', async () => {
    const { svcm, endpoints } = makeSpySvcm()
    const { opts } = makeOpts({ svcm })

    const result = await registerAgent(opts)

    expect(endpoints).toEqual(['prompt', 'status'])
    clearInterval(result!.heartbeatTimer)
  })
})

describe('registerAgent — heartbeat identity payload (BOB-460/468)', () => {
  test('org/repo/worktree/host/session_nanoid land on the periodic heartbeat and the §8.7 status reply', async () => {
    const identity = deriveHarnessIdentity('/Users/rob/repos/bob-ms/hub/bob-468-hb-identity')
    const subject = AgentSubject.new('claude-code', 'rob', 'sess-nanoid-abc', { subjectToken: 'cc' })

    function buildHeartbeat(id: string): Uint8Array {
      return encodeHeartbeatPayload(
        buildHeartbeatPayload(subject, 30, id, {
          session: 'sess-nanoid-abc',
          extras: {
            host: 'm3',
            session_nanoid: 'sess-nanoid-abc',
            org: identity.org,
            repo: identity.repo,
            worktree: identity.worktree,
          },
        }),
      )
    }

    const statusHandlers: Record<string, (err: Error | null, msg: ServiceMsg) => void> = {}
    const service: ServiceLike = {
      addEndpoint: (name, endpointOpts) => {
        statusHandlers[name] = (endpointOpts as { handler: (err: Error | null, msg: ServiceMsg) => void }).handler
      },
      info: () => ({ id: 'inst-xyz' }),
      stop: async () => {},
    }
    const svcm: ServiceManagerLike = { add: async () => service }

    const publishes: Array<{ subject: string; payload: Uint8Array }> = []
    const opts: RegisterAgentOptions = {
      noRegister: false,
      nc: {
        publish: (subject: string, payload?: Uint8Array) =>
          void publishes.push({ subject, payload: payload ?? new Uint8Array() }),
      },
      svcm,
      serviceName: SERVICE_NAME,
      version: '9.9.9',
      description: 'Claude Code — test',
      metadata: { agent: 'claude-code', owner: 'rob' },
      promptSubject: 'agents.prompt.cc.rob.test',
      promptQueue: 'prompt-q',
      promptMetadata: { max_payload: '1MB' },
      statusSubject: 'agents.status.cc.rob.test',
      statusQueue: 'status-q',
      heartbeatSubject: 'agents.hb.cc.rob.test',
      heartbeatIntervalMs: 5000,
      onPrompt: () => {},
      buildHeartbeat,
    }

    const result = await registerAgent(opts)

    const published = publishes.find((p) => p.subject === 'agents.hb.cc.rob.test')
    expect(published).toBeDefined()
    const heartbeatBody = JSON.parse(new TextDecoder().decode(published!.payload))

    // Harness facts, not agent-authored: org/repo/worktree derive from the
    // fleet checkout layout, host and session_nanoid from the runtime.
    expect(heartbeatBody.org).toBe('bob-ms')
    expect(heartbeatBody.repo).toBe('hub')
    expect(heartbeatBody.worktree).toBe('bob-468-hb-identity')
    expect(heartbeatBody.host).toBe('m3')
    expect(heartbeatBody.session_nanoid).toBe('sess-nanoid-abc')

    let statusReply: Uint8Array | undefined
    statusHandlers.status!(null, {
      respond: (bytes: Uint8Array) => {
        statusReply = bytes
      },
      respondError: () => {},
    } as unknown as ServiceMsg)

    expect(statusReply).toBeDefined()
    const statusBody = JSON.parse(new TextDecoder().decode(statusReply!))
    // Same builder, same fields — only `ts` may drift between the two calls.
    delete heartbeatBody.ts
    delete statusBody.ts
    expect(statusBody).toEqual(heartbeatBody)

    clearInterval(result!.heartbeatTimer)
  })
})
