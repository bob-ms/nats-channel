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
import { connect, type NatsConnection } from '@nats-io/transport-node'
import type { ServiceMsg } from '@nats-io/services'
import { ReferenceAgent } from '@synadia-ai/agent-service/testing'
import { encodeChunk } from '@synadia-ai/agent-service'
import { listPeers, promptPeer, type PeerIdentity } from './peers'

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

beforeAll(async () => {
  if (!hasServer) return
  serverProc = Bun.spawn([serverBin, '-p', String(PORT), '-a', '127.0.0.1'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
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
