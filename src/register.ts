// The plane-registration seam: builds the `agents` micro-service (`svcm.add` +
// prompt/status endpoints) and starts the §8 heartbeat loop for a cc session —
// or, when `noRegister` is set (`NATS_NO_REGISTER`, BOB-416's tools-only launch
// mode), skips all of it and returns null. Extracted from `server.ts` so the
// guard is a unit-testable seam: an injected spy service manager proves
// `svcm.add` is never called in no-register mode, and called exactly as before
// otherwise. `server.ts` stays the single bootstrap — this is one code path
// behind a flag, not a fork of the server.

import { Svcm } from '@nats-io/services'
import type { ServiceMsg } from '@nats-io/services'
import type { NatsConnection } from '@nats-io/transport-node'

// The structural minimum of `@nats-io/services` this seam depends on — kept
// narrow so both the real `Svcm`/`Service` and a test spy satisfy it.
export interface ServiceLike {
  addEndpoint(name: string, opts: unknown): void
  info(): { id: string }
  stop(): Promise<unknown>
}
export interface ServiceManagerLike {
  add(config: unknown): Promise<ServiceLike>
}

export type RegisteredAgent = {
  service: ServiceLike
  instanceId: string
  heartbeatTimer: ReturnType<typeof setInterval>
}

export type RegisterAgentOptions = {
  /** `NATS_NO_REGISTER` — true skips registration entirely and returns null. */
  noRegister: boolean
  nc: Pick<NatsConnection, 'publish'>
  /** Injectable for tests; defaults to `new Svcm(nc)`. */
  svcm?: ServiceManagerLike
  serviceName: string
  version: string
  description: string
  metadata: Record<string, string>
  promptSubject: string
  promptQueue: string
  promptMetadata: Record<string, string>
  statusSubject: string
  statusQueue: string
  heartbeatSubject: string
  heartbeatIntervalMs: number
  onPrompt: (err: Error | null, msg: ServiceMsg) => void
  /** Builds the §8.3 heartbeat/status payload once the instanceId is known. */
  buildHeartbeat: (instanceId: string) => Uint8Array
}

/**
 * Register the session as an `agents` micro service and start its heartbeat,
 * unless `noRegister` is set. Returns the live handles the caller needs for
 * shutdown, or null in tools-only mode (nothing to tear down).
 */
export async function registerAgent(
  opts: RegisterAgentOptions,
): Promise<RegisteredAgent | null> {
  if (opts.noRegister) return null

  const svcm =
    opts.svcm ?? (new Svcm(opts.nc as NatsConnection) as unknown as ServiceManagerLike)

  const service = await svcm.add({
    name: opts.serviceName,
    version: opts.version,
    description: opts.description,
    metadata: opts.metadata,
    queue: '',
  })

  service.addEndpoint('prompt', {
    subject: opts.promptSubject,
    queue: opts.promptQueue,
    handler: (err: Error | null, msg: ServiceMsg) => opts.onPrompt(err, msg),
    metadata: opts.promptMetadata,
  })

  const instanceId = service.info().id

  // §8.7 (v0.3): status request/response replies with a freshly-built §8.3
  // heartbeat payload — same shape as the periodic heartbeat, different
  // transport (request/response instead of pub/sub).
  service.addEndpoint('status', {
    subject: opts.statusSubject,
    queue: opts.statusQueue,
    handler: (err: Error | null, msg: ServiceMsg) => {
      if (err) return
      try {
        msg.respond(opts.buildHeartbeat(instanceId))
      } catch (e) {
        try {
          msg.respondError(500, `status handler error: ${(e as Error).message}`)
        } catch {
          // connection may already be gone
        }
      }
    },
  })

  const publishHeartbeat = (): void => {
    opts.nc.publish(opts.heartbeatSubject, opts.buildHeartbeat(instanceId))
  }
  publishHeartbeat()
  const heartbeatTimer = setInterval(publishHeartbeat, opts.heartbeatIntervalMs)
  heartbeatTimer.unref()

  return { service, instanceId, heartbeatTimer }
}
