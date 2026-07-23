// Runtime-agnostic fleet-peer operations over the A2A control plane: a fresh
// `$SRV.PING`+`$SRV.INFO` registry scan (`listPeers`) and a bounded prompt →
// stream-reply round-trip (`promptPeer`). Both take a live `NatsConnection` and
// own only an `Agents` client (closed in a `finally`), so `server.ts` (cc) and
// the pi ticket (BOB-413) drive the same code. The `PeerRow` projection is the
// serialized shape the MCP tools hand back to the model.

import {
  Agents,
  decodeChunk,
  type Agent,
  type NatsConnection,
} from '@synadia-ai/agents'

import { mintSessionName } from './identity'

export type PeerIdentity = { runtime: string; owner: string; name: string; host?: string }

export type PeerRow = PeerIdentity & {
  host?: string
  role: string
  session?: string
  description?: string
  instanceId: string
  promptable: boolean
}

export type PeerTarget = { name: string; owner?: string; runtime?: string }

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000

/** Empty headerless reply = §6.5 stream terminator. */
function isTerminator(bytes: Uint8Array): boolean {
  return bytes.byteLength === 0
}

/**
 * A JetStream publish ack (`{"stream":"AGENTS_EVENTS","domain":"bobms","seq":6}`
 * as captured live, BOB-475): what the server sends to the request inbox when a
 * JetStream stream's subject space overlaps the requested subject. Never a
 * steward reply — those carry `session_id` (success) or service-error headers.
 */
function isJetStreamPubAck(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false
  const p = parsed as Record<string, unknown>
  return typeof p.stream === 'string' && typeof p.seq === 'number' && !('session_id' in p)
}

export function rowFromAgent(agent: Agent): PeerRow {
  const role = agent.metadata.role ?? 'session'
  return {
    // 3rd wire token of the prompt subject is the runtime (`cc`/`pi`).
    runtime: agent.promptEndpoint.subject.split('.')[2] ?? '',
    owner: agent.owner,
    name: agent.name,
    host: agent.metadata.host,
    role,
    session: agent.session,
    description: agent.description || undefined,
    instanceId: agent.instanceId,
    promptable: role !== 'controller',
  }
}

export async function listPeers(
  nc: NatsConnection,
  opts?: { excludeInstanceId?: string },
): Promise<PeerRow[]> {
  const agents = new Agents({ nc })
  try {
    const found = await agents.discover()
    return found
      .map(rowFromAgent)
      .filter(row => row.instanceId !== opts?.excludeInstanceId)
  } finally {
    await agents.close()
  }
}

function describeTarget(target: PeerTarget): string {
  const parts = [target.name]
  if (target.owner) parts.push(`owner=${target.owner}`)
  if (target.runtime) parts.push(`runtime=${target.runtime}`)
  return parts.join(' ')
}

function candidateLabel(row: PeerRow): string {
  return `${row.runtime}/${row.owner}/${row.name}@${row.host ?? '?'}`
}

export async function promptPeer(
  nc: NatsConnection,
  target: PeerTarget,
  promptText: string,
  sender: PeerIdentity,
  opts?: { timeoutMs?: number },
): Promise<{ text: string; peer: PeerRow }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
  const agents = new Agents({ nc })
  try {
    const found = await agents.discover()
    const matches = found
      .map(agent => ({ agent, row: rowFromAgent(agent) }))
      .filter(
        ({ row }) =>
          row.name === target.name &&
          (target.owner === undefined || row.owner === target.owner) &&
          (target.runtime === undefined || row.runtime === target.runtime),
      )

    if (matches.length === 0) {
      throw new Error(
        `no live peer matches ${describeTarget(target)} — it is unknown or unreachable`,
      )
    }

    const promptable = matches.filter(({ row }) => row.promptable)
    if (promptable.length === 0) {
      const names = matches.map(({ row }) => candidateLabel(row)).join(', ')
      throw new Error(`${target.name} is a controller, not a promptable target (${names})`)
    }
    if (promptable.length > 1) {
      const candidates = promptable.map(({ row }) => candidateLabel(row)).join(', ')
      throw new Error(
        `${target.name} is ambiguous — it matches more than one live peer: ${candidates}. ` +
          `Re-address with owner and/or runtime.`,
      )
    }

    const { agent, row } = promptable[0]!
    // The caller's claimed identity rides the request payload for the audit
    // stream; the peer trusts it as sender-stamped, not authenticated.
    const envelope = JSON.stringify({ prompt: promptText, sender })
    const bytes = new TextEncoder().encode(envelope)

    const iter = await nc.requestMany(agent.promptSubject, bytes, { maxWait: timeoutMs })

    let acc = ''
    let sawTerminator = false
    for await (const m of iter) {
      const errCode = m.headers?.get('Nats-Service-Error-Code')
      if (errCode) {
        const errMsg = m.headers?.get('Nats-Service-Error') || 'service error'
        throw new Error(`peer ${row.name} returned a service error (${errCode}): ${errMsg}`)
      }
      if (isTerminator(m.data)) {
        sawTerminator = true
        break
      }
      const chunk = decodeChunk(m.data)
      if (chunk?.type === 'response') acc += chunk.text
    }

    if (!sawTerminator) {
      throw new Error(
        `peer ${row.name} did not complete its reply within ${timeoutMs}ms (timed out or stopped responding)`,
      )
    }

    return { text: acc, peer: row }
  } finally {
    await agents.close()
  }
}

/** Which steward controller answers the spawn; all fields narrow the match. */
export type StewardTarget = { steward?: string; owner?: string; runtime?: string }

/** The spawn parameters the steward endpoint accepts (host BOB-460 contract). */
export type SpawnAgentRequest = {
  /** `org/repo` under the fleet checkout convention — always a fresh branch + worktree. */
  repo: string
  /** Ancestry for the fresh branch (repo default branch when omitted). */
  base?: string
  /** Requested lifetime in seconds; steward-defaulted and ceiling-clamped. */
  maxLifetimeS?: number
  /** Initial prompt / slash command for the child. */
  prompt: string
  /** Optional model override. */
  model?: string
}

export type SpawnAgentReply = {
  /** The steward-minted child nanoid — the wire name, addressable a priori. */
  session_id: string
  spawn_token?: string
  [key: string]: unknown
}

/** Spawns bound worktree creation + harness start (the steward's own spawn
 *  timeout is 120s), so the round-trip waits longer than a prompt would. */
const DEFAULT_SPAWN_TIMEOUT_MS = 150_000

function describeStewardTarget(target: StewardTarget): string {
  const parts: string[] = []
  if (target.steward) parts.push(target.steward)
  if (target.owner) parts.push(`owner=${target.owner}`)
  if (target.runtime) parts.push(`runtime=${target.runtime}`)
  return parts.length > 0 ? parts.join(' ') : 'any live steward'
}

/**
 * Ask a steward controller to spawn a fresh peer session (BOB-473). Mints the
 * spawn token here (the idempotency key the steward's KV gate honours — host
 * BOB-469), stamps the caller's claimed identity exactly as `promptPeer` does,
 * and returns the steward's reply whole: `session_id` is the child's nanoid,
 * addressable at `agents.prompt.<runtime>.<owner>.<nanoid>` before the child
 * finishes booting. Steward rejections (clamp, claim conflict, token replay,
 * in-progress conflict) surface verbatim in the thrown error.
 */
export async function spawnAgent(
  nc: NatsConnection,
  target: StewardTarget,
  request: SpawnAgentRequest,
  sender: PeerIdentity,
  opts?: { timeoutMs?: number; spawnToken?: string },
): Promise<{ reply: SpawnAgentReply; steward: PeerRow; spawnToken: string; promptSubject: string }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
  const agents = new Agents({ nc })
  try {
    const found = await agents.discover()
    const stewards = found
      .map(agent => ({ agent, row: rowFromAgent(agent) }))
      .filter(
        ({ row }) =>
          row.role === 'controller' &&
          (target.steward === undefined || row.name === target.steward) &&
          (target.owner === undefined || row.owner === target.owner) &&
          (target.runtime === undefined || row.runtime === target.runtime),
      )

    if (stewards.length === 0) {
      throw new Error(
        `no live steward controller matches ${describeStewardTarget(target)} — ` +
          `list_agents shows controllers with role 'controller'`,
      )
    }
    if (stewards.length > 1) {
      const candidates = stewards.map(({ row }) => candidateLabel(row)).join(', ')
      throw new Error(
        `${describeStewardTarget(target)} is ambiguous — it matches more than one live steward: ` +
          `${candidates}. Re-address with steward, owner, and/or runtime.`,
      )
    }

    const { agent, row } = stewards[0]!
    // The spawn endpoint lives beside the prompt endpoint on the same
    // verb-first tree: swap the verb token.
    const tokens = agent.promptEndpoint.subject.split('.')
    if (tokens[1] !== 'prompt') {
      throw new Error(`steward ${row.name} has an unexpected endpoint subject: ${agent.promptEndpoint.subject}`)
    }
    tokens[1] = 'spawn'
    const spawnSubject = tokens.join('.')

    const spawnToken = opts?.spawnToken ?? mintSessionName()
    // Same claimed-stamp posture as promptPeer: `sender` rides the payload for
    // the steward's record, trusted as sender-stamped, never authenticated.
    const envelope = JSON.stringify({
      repo: request.repo,
      ...(request.base !== undefined ? { base: request.base } : {}),
      ...(request.maxLifetimeS !== undefined ? { max_lifetime_s: request.maxLifetimeS } : {}),
      prompt: request.prompt,
      ...(request.model !== undefined ? { model: request.model } : {}),
      spawn_token: spawnToken,
      sender,
    })

    // The spawn subject is also captured by the AGENTS_EVENTS JetStream stream
    // (the BOB-472 spawn-record tree overlaps `agents.spawn.>`), so the request
    // inbox receives the stream's PubAck alongside — and usually before — the
    // steward's reply (BOB-475). Collect replies and let the first non-PubAck
    // message decide the outcome.
    let reply: SpawnAgentReply | undefined
    let stewardError: Error | undefined
    try {
      const iter = await nc.requestMany(spawnSubject, new TextEncoder().encode(envelope), {
        maxWait: timeoutMs,
      })
      for await (const m of iter) {
        const errCode = m.headers?.get('Nats-Service-Error-Code')
        if (errCode) {
          const errMsg = m.headers?.get('Nats-Service-Error') || 'service error'
          stewardError = new Error(`steward ${row.name} rejected the spawn (${errCode}): ${errMsg}`)
          break
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(new TextDecoder().decode(m.data))
        } catch {
          stewardError = new Error(`steward ${row.name} returned an unparseable spawn reply`)
          break
        }
        if (isJetStreamPubAck(parsed)) continue
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as SpawnAgentReply).session_id !== 'string' ||
          ((parsed as SpawnAgentReply).session_id as string).length === 0
        ) {
          stewardError = new Error(`steward ${row.name} returned a spawn reply without a session_id`)
          break
        }
        reply = parsed as SpawnAgentReply
        break
      }
    } catch (e) {
      if (e instanceof Error && /503|no responders/i.test(e.message)) {
        throw new Error(`steward ${row.name} is not listening on its spawn endpoint (${spawnSubject})`)
      }
      throw e
    }

    if (stewardError) throw stewardError
    if (reply === undefined) {
      throw new Error(
        `steward ${row.name} did not answer the spawn within ${timeoutMs}ms — the spawn may still ` +
          `be running; retry with the same spawn token (${spawnToken}) to learn its outcome`,
      )
    }

    return {
      reply,
      steward: row,
      spawnToken,
      promptSubject: `agents.prompt.${row.runtime}.${row.owner}.${reply.session_id}`,
    }
  } finally {
    await agents.close()
  }
}
