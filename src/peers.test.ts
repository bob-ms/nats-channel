// Integration coverage for the runtime-agnostic peer ops against a real
// ephemeral `nats-server` and the SDK `ReferenceAgent` harness. Skipped whole
// when no `nats-server` binary is reachable; on the dev fleet it is, so these
// run. Every ReferenceAgent is `stop()`ed and the connection drained so the
// registry scan sees only what each test started.

import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
  afterEach,
} from 'bun:test'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { connect, headers, type NatsConnection } from '@nats-io/transport-node'
import type { ServiceMsg } from '@nats-io/services'
import { ReferenceAgent } from '@synadia-ai/agent-service/testing'
import { encodeChunk } from '@synadia-ai/agent-service'
import { listPeers, promptPeer, spawnAgent, type PeerIdentity } from './peers'

const SERVER_BIN = '/opt/homebrew/bin/nats-server'
const hasServer = (() => {
  try {
    if (Bun.file(SERVER_BIN).size >= 0) return true
  } catch {
    /* fall through to PATH lookup */
  }
  return !!Bun.which('nats-server')
})()

const PORT = 14822
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

const SENDER: PeerIdentity = { runtime: 'cc', owner: 'rob', name: 'gsd-test' }

async function waitForConnectable(url: string, attempts = 40): Promise<NatsConnection> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await connect({ servers: url, name: 'peers-test' })
    } catch (e) {
      lastErr = e
      await Bun.sleep(100)
    }
  }
  throw lastErr
}

const started: ReferenceAgent[] = []
async function startAgent(opts: ConstructorParameters<typeof ReferenceAgent>[0]): Promise<ReferenceAgent> {
  const ref = new ReferenceAgent(opts)
  await ref.start()
  started.push(ref)
  return ref
}

// JetStream is on so the BOB-475 tests can stand up a real stream over the
// spawn subject; the store dir is per-process to survive parallel runs.
const JS_STORE_DIR = `${tmpdir()}/nats-peers-test-js-${process.pid}`

beforeAll(async () => {
  if (!hasServer) return
  serverProc = Bun.spawn(
    [serverBin, '-p', String(PORT), '-a', '127.0.0.1', '-js', '-sd', JS_STORE_DIR],
    {
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
  nc = await waitForConnectable(`127.0.0.1:${PORT}`)
})

afterAll(async () => {
  if (!hasServer) return
  try {
    await nc?.drain()
  } catch {
    /* ignore */
  }
  serverProc?.kill()
  await serverProc?.exited
  rmSync(JS_STORE_DIR, { recursive: true, force: true })
})

afterEach(async () => {
  while (started.length > 0) {
    const ref = started.pop()!
    try {
      await ref.stop()
    } catch {
      /* ignore */
    }
  }
})

// Echo handler: stash the decoded envelope for sender-stamp assertions, then
// reply with one response chunk + the empty terminator.
function makeEchoHandler(capture: { envelope?: unknown }) {
  return (msg: ServiceMsg) => {
    const env = JSON.parse(new TextDecoder().decode(msg.data)) as { prompt: string }
    capture.envelope = env
    const reply = msg.reply
    if (!reply) return
    nc.publish(reply, encodeChunk({ type: 'response', text: 'echo:' + env.prompt }))
    nc.publish(reply, new Uint8Array(0))
  }
}

describe.skipIf(!hasServer)('peers — integration', () => {
  test('ReferenceAgent produces the runtime token we extract', async () => {
    const ref = await startAgent({ nc, agent: 'cc', owner: 'rob', name: 'token-probe', heartbeatIntervalS: 1 })
    // The 3rd wire token drives rowFromAgent.runtime; assert on ground truth.
    expect(ref.promptSubject.split('.')[2]).toBe('cc')
  })

  test('listPeers returns a started session with host, runtime token, and role/promptable', async () => {
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'peer-alpha',
      session: 'sess-alpha',
      extraMetadata: { host: 'vert' },
      heartbeatIntervalS: 1,
    })
    const rows = await listPeers(nc)
    const row = rows.find(r => r.name === 'peer-alpha')
    expect(row).toBeDefined()
    expect(row!.runtime).toBe('cc')
    expect(row!.host).toBe('vert')
    expect(row!.role).toBe('session')
    expect(row!.promptable).toBe(true)
    expect(row!.session).toBe('sess-alpha')
  })

  test('empty fleet → listPeers returns []', async () => {
    const rows = await listPeers(nc)
    expect(rows).toEqual([])
  })

  test('round-trip: promptPeer echoes and stamps the sender', async () => {
    const capture: { envelope?: unknown } = {}
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'peer-echo',
      promptHandler: makeEchoHandler(capture),
      heartbeatIntervalS: 1,
    })
    const { text } = await promptPeer(nc, { name: 'peer-echo' }, 'hi', SENDER)
    expect(text).toBe('echo:hi')
    expect((capture.envelope as { sender: PeerIdentity }).sender).toEqual(SENDER)
  })

  test('unknown peer rejects with a clear error', async () => {
    await expect(promptPeer(nc, { name: 'nobody-here' }, 'x', SENDER)).rejects.toThrow(
      /unknown|unreachable|no live peer/i,
    )
  })

  test('bare-name ambiguity rejects listing candidates', async () => {
    const capture: { envelope?: unknown } = {}
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'peer-dup',
      promptHandler: makeEchoHandler(capture),
      heartbeatIntervalS: 1,
    })
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'kevin',
      name: 'peer-dup',
      promptHandler: makeEchoHandler(capture),
      heartbeatIntervalS: 1,
    })
    await expect(promptPeer(nc, { name: 'peer-dup' }, 'x', SENDER)).rejects.toThrow(
      /ambiguous|matches more than one|candidates/i,
    )
    // Disambiguating by owner resolves it.
    const { text } = await promptPeer(nc, { name: 'peer-dup', owner: 'kevin' }, 'y', SENDER)
    expect(text).toBe('echo:y')
  })

  test('controller lists as not promptable and rejects prompting', async () => {
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'control-m3',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    const rows = await listPeers(nc)
    const row = rows.find(r => r.name === 'control-m3')
    expect(row).toBeDefined()
    expect(row!.role).toBe('controller')
    expect(row!.promptable).toBe(false)
    await expect(promptPeer(nc, { name: 'control-m3' }, 'x', SENDER)).rejects.toThrow(
      /controller|not a promptable/i,
    )
  })

  test('liveness: a stopped agent drops out of listPeers', async () => {
    const ref = await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'peer-transient',
      heartbeatIntervalS: 1,
    })
    let rows = await listPeers(nc)
    expect(rows.some(r => r.name === 'peer-transient')).toBe(true)

    await ref.stop()
    const idx = started.indexOf(ref)
    if (idx >= 0) started.splice(idx, 1)

    rows = await listPeers(nc)
    expect(rows.some(r => r.name === 'peer-transient')).toBe(false)
  })

  // ── spawn_agent (BOB-473) ─────────────────────────────────────────────────
  // The fake steward is a controller-role ReferenceAgent for discovery plus a
  // plain subscription on its derived spawn subject standing in for the host
  // controllers' spawn endpoint (request/reply, service-error headers).

  function spawnSubjectOf(ref: ReferenceAgent): string {
    return ref.promptSubject
      .split('.')
      .map((t, i) => (i === 1 ? 'spawn' : t))
      .join('.')
  }

  test('spawnAgent frames the request, mints a nanoid spawn token, and stamps the sender', async () => {
    const ref = await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'control-spawn',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    const captured: { payload?: Record<string, unknown> } = {}
    const sub = nc.subscribe(spawnSubjectOf(ref), {
      callback: (_err, msg) => {
        captured.payload = JSON.parse(new TextDecoder().decode(msg.data)) as Record<string, unknown>
        msg.respond(
          JSON.stringify({
            session_id: 'k3x9m2vp7h4wz8n1t5rj6',
            spawn_token: captured.payload.spawn_token,
            cwd: '/tmp/wt',
          }),
        )
      },
    })
    try {
      const res = await spawnAgent(
        nc,
        {},
        { repo: 'bob-ms/hub', base: 'main', prompt: '/drain', model: 'sonnet', maxLifetimeS: 3600 },
        SENDER,
      )
      expect(res.reply.session_id).toBe('k3x9m2vp7h4wz8n1t5rj6')
      expect(res.promptSubject).toBe('agents.prompt.cc.rob.k3x9m2vp7h4wz8n1t5rj6')
      expect(res.steward.name).toBe('control-spawn')
      expect(captured.payload).toMatchObject({
        repo: 'bob-ms/hub',
        base: 'main',
        prompt: '/drain',
        model: 'sonnet',
        max_lifetime_s: 3600,
      })
      // Plugin-minted spawn token: the 21-char subject-safe nanoid shape.
      expect(captured.payload!.spawn_token).toMatch(/^[0-9a-z_-]{21}$/)
      expect(res.spawnToken).toBe(captured.payload!.spawn_token as string)
      // Claimed requester stamp, attached exactly as promptPeer attaches it.
      expect(captured.payload!.sender).toEqual(SENDER)
    } finally {
      sub.unsubscribe()
    }
  })

  test('spawnAgent omits absent optional fields from the wire request', async () => {
    const ref = await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'control-min',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    const captured: { payload?: Record<string, unknown> } = {}
    const sub = nc.subscribe(spawnSubjectOf(ref), {
      callback: (_err, msg) => {
        captured.payload = JSON.parse(new TextDecoder().decode(msg.data)) as Record<string, unknown>
        msg.respond(JSON.stringify({ session_id: 'a1b2c3d4e5f6g7h8i9j0k' }))
      },
    })
    try {
      await spawnAgent(nc, {}, { repo: 'bob-ms/hub', prompt: 'go' }, SENDER)
      expect(Object.keys(captured.payload!).sort()).toEqual(['prompt', 'repo', 'sender', 'spawn_token'])
    } finally {
      sub.unsubscribe()
    }
  })

  test('steward service errors surface verbatim', async () => {
    const ref = await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'control-err',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    const stewardMessage =
      'spawn attempt for this token (child a1b2, started 2026-07-23T00:00:00Z) exceeded the 120000ms spawn timeout and is adjudicated crashed — mint a fresh spawn token to retry'
    const sub = nc.subscribe(spawnSubjectOf(ref), {
      callback: (_err, msg) => {
        const h = headers()
        h.set('Nats-Service-Error-Code', '409')
        h.set('Nats-Service-Error', stewardMessage)
        msg.respond(new Uint8Array(0), { headers: h })
      },
    })
    try {
      await expect(
        spawnAgent(nc, { steward: 'control-err' }, { repo: 'bob-ms/hub', prompt: 'go' }, SENDER),
      ).rejects.toThrow(`steward control-err rejected the spawn (409): ${stewardMessage}`)
    } finally {
      sub.unsubscribe()
    }
  })

  test('no live steward — and plain sessions are never spawn targets', async () => {
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'peer-not-steward',
      heartbeatIntervalS: 1,
    })
    await expect(
      spawnAgent(nc, { steward: 'peer-not-steward' }, { repo: 'bob-ms/hub', prompt: 'go' }, SENDER),
    ).rejects.toThrow(/no live steward/i)
    await expect(spawnAgent(nc, {}, { repo: 'bob-ms/hub', prompt: 'go' }, SENDER)).rejects.toThrow(
      /no live steward/i,
    )
  })

  test('two live stewards without a target is ambiguous', async () => {
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'control-a',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'control-b',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    await expect(spawnAgent(nc, {}, { repo: 'bob-ms/hub', prompt: 'go' }, SENDER)).rejects.toThrow(
      /ambiguous|more than one live steward/i,
    )
  })

  test('spawnAgent surfaces a missing spawn endpoint distinctly', async () => {
    await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'control-deaf',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    // Controller discovered, but nothing subscribed on its spawn subject.
    await expect(
      spawnAgent(nc, { steward: 'control-deaf' }, { repo: 'bob-ms/hub', prompt: 'go' }, SENDER),
    ).rejects.toThrow(/not listening on its spawn endpoint/i)
  })

  // ── BOB-475: the JetStream PubAck racing the steward reply ────────────────
  // On the live plane the AGENTS_EVENTS stream (BOB-472 spawn records)
  // captures `agents.spawn.>`, so the server's PubAck lands on the request
  // inbox ahead of the steward's reply — 0.3.0's single-message request took
  // the ack as the reply and every outcome surfaced as "no session_id". These
  // tests stand up a REAL stream over the spawn subject via $JS.API (deleted
  // after), so the ack is server-generated, not hand-rolled; the steward
  // replies use the host pi controller's actual envelopes (controller.ts:
  // success = SpawnDescriptor + spawn_token JSON body, error = respondError's
  // Nats-Service-Error/-Code headers with an empty body).

  async function withAgentsEventsStream(fn: () => Promise<void>): Promise<void> {
    const create = await nc.request(
      '$JS.API.STREAM.CREATE.AGENTS_EVENTS',
      JSON.stringify({
        name: 'AGENTS_EVENTS',
        subjects: ['agents.spawn.>'],
        storage: 'memory',
        retention: 'limits',
      }),
      { timeout: 5000 },
    )
    const created = JSON.parse(new TextDecoder().decode(create.data)) as {
      error?: { description?: string }
    }
    if (created.error) throw new Error(`stream create failed: ${created.error.description}`)
    try {
      await fn()
    } finally {
      await nc.request('$JS.API.STREAM.DELETE.AGENTS_EVENTS', new Uint8Array(0), { timeout: 5000 })
    }
  }

  test('spawn success surfaces the child through the PubAck race (BOB-475)', async () => {
    const ref = await startAgent({
      nc,
      agent: 'pi',
      owner: 'rob',
      name: 'control-red',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    const sub = nc.subscribe(spawnSubjectOf(ref), {
      callback: (_err, msg) => {
        const env = JSON.parse(new TextDecoder().decode(msg.data)) as { spawn_token: string }
        void (async () => {
          // Let the stream's PubAck land on the inbox first, as observed live.
          await Bun.sleep(50)
          msg.respond(
            JSON.stringify({
              session_id: 'e4omczqy7fzly49mu-667',
              subject: 'agents.prompt.pi.rob.e4omczqy7fzly49mu-667',
              heartbeat_subject: 'agents.hb.pi.rob.e4omczqy7fzly49mu-667',
              status_subject: 'agents.status.pi.rob.e4omczqy7fzly49mu-667',
              cwd: '/home/rob/worktrees/hub/e4omczqy7fzly49mu-667',
              max_lifetime_s: 3600,
              created_at: '2026-07-23T10:00:00.000Z',
              instance_id: 'svc-instance-1',
              spawn_token: env.spawn_token,
            }),
          )
        })()
      },
    })
    try {
      await withAgentsEventsStream(async () => {
        const res = await spawnAgent(
          nc,
          { steward: 'control-red' },
          { repo: 'bob-ms/hub', prompt: 'go' },
          SENDER,
          { timeoutMs: 5000 },
        )
        expect(res.reply.session_id).toBe('e4omczqy7fzly49mu-667')
        expect(res.reply.spawn_token).toBe(res.spawnToken)
        expect(res.promptSubject).toBe('agents.prompt.pi.rob.e4omczqy7fzly49mu-667')
      })
    } finally {
      sub.unsubscribe()
    }
  })

  test('steward errors surface verbatim through the PubAck race (BOB-475)', async () => {
    const ref = await startAgent({
      nc,
      agent: 'pi',
      owner: 'rob',
      name: 'control-red',
      extraMetadata: { role: 'controller' },
      heartbeatIntervalS: 1,
    })
    const sub = nc.subscribe(spawnSubjectOf(ref), {
      callback: (_err, msg) => {
        void (async () => {
          await Bun.sleep(50)
          const h = headers()
          h.set('Nats-Service-Error-Code', '400')
          h.set('Nats-Service-Error', 'repo must be org/repo: hub')
          msg.respond(new Uint8Array(0), { headers: h })
        })()
      },
    })
    try {
      await withAgentsEventsStream(async () => {
        await expect(
          spawnAgent(nc, { steward: 'control-red' }, { repo: 'hub', prompt: 'go' }, SENDER, {
            timeoutMs: 5000,
          }),
        ).rejects.toThrow('steward control-red rejected the spawn (400): repo must be org/repo: hub')
      })
    } finally {
      sub.unsubscribe()
    }
  })

  test('self is excluded by instanceId', async () => {
    const ref = await startAgent({
      nc,
      agent: 'cc',
      owner: 'rob',
      name: 'peer-self',
      heartbeatIntervalS: 1,
    })
    const rows = await listPeers(nc, { excludeInstanceId: ref.instanceId })
    expect(rows.some(r => r.name === 'peer-self')).toBe(false)
  })
})
