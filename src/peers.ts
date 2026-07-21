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

export type PeerIdentity = { runtime: string; owner: string; name: string }

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
