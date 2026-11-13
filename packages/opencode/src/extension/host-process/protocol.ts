import { randomUUID } from "node:crypto"
import { Schema } from "effect"

/**
 * Internal worker control protocol (remediation T5.1), not an extension-kit
 * compatibility promise. Migrated from
 * `specs/extensions/prototypes/src/extension/execution-protocol.ts` and
 * extended per `specs/extensions/process-isolation-design.md` §2.2: `init`
 * follows `hello`, `notify` carries fire-and-forget traffic, and
 * `host.call`/`host.result`/`host.rejected` form the reverse request channel
 * (worker → host), which the v1 `input.client` stub still requires to exist.
 */
export const PROTOCOL_VERSION = 1

const uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
)
/** Request identity scoped to one worker; no command is replayed after disconnection. */
export const RequestID = uuid.pipe(Schema.brand("ExtensionHostProcessRequestID"))
/** Reverse-channel identity scoped to one worker; counted independently of {@link RequestID}. */
export const CallID = uuid.pipe(Schema.brand("ExtensionHostProcessCallID"))
/** Identity of one worker process, never reused after restart. */
export const RuntimeID = uuid.pipe(Schema.brand("ExtensionHostProcessRuntimeID"))
/** Exact integer counters reject overflow rather than reuse a fencing value. */
export const Counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

/**
 * Fence attached to every control frame. `generation`/`epoch` are the slot
 * counters from `runtime/slot.ts` (design §4.1); `store`/`installation` are
 * opaque ownership tokens minted by the lifecycle layer; `runtime` changes on
 * every (re)spawn so frames from a previous worker can never resolve work.
 */
export const RuntimeIdentity = Schema.Struct({
  store: Schema.String,
  installation: Schema.String,
  generation: Counter,
  runtime: RuntimeID,
  epoch: Counter,
})
export type RuntimeIdentity = typeof RuntimeIdentity.Type

/**
 * Compare the complete runtime fence, not a PID or runtime alone.
 * @param left Expected worker identity.
 * @param right Received worker identity.
 * @returns Whether all ownership and epoch fields match.
 */
export function sameRuntime(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return (
    left.store === right.store &&
    left.installation === right.installation &&
    left.generation === right.generation &&
    left.runtime === right.runtime &&
    left.epoch === right.epoch
  )
}

/**
 * Mint the identity for one worker launch; the caller supplies the durable
 * fence coordinates and each launch receives a fresh `runtime`.
 */
export function makeIdentity(fields: {
  store: string
  installation: string
  generation: number
  epoch: number
}): RuntimeIdentity {
  return Schema.decodeUnknownSync(RuntimeIdentity)({ ...fields, runtime: randomUUID() })
}

const envelope = { version: Schema.Literal(PROTOCOL_VERSION), identity: RuntimeIdentity }

/** Rejection vocabulary for both request and reverse-call failures. */
export const RejectionCode = Schema.Literals(["closed", "cancelled", "requestFailed", "capacity", "denied"])
export type RejectionCode = typeof RejectionCode.Type

/**
 * Host → worker commands. `init` is admitted before any business traffic and
 * carries the extension load payload (entry dir, settings snapshot, identity —
 * concretely defined when T5.2 fills the worker entrypoint).
 */
export const HostCommand = Schema.Union([
  Schema.Struct({ ...envelope, type: Schema.Literal("init"), value: Schema.Json }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("request"),
    requestId: RequestID,
    method: Schema.String,
    value: Schema.Json,
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("cancel"), requestId: RequestID }),
  Schema.Struct({ ...envelope, type: Schema.Literals(["drain", "dispose"]) }),
  Schema.Struct({ ...envelope, type: Schema.Literal("host.result"), callId: CallID, value: Schema.Json }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("host.rejected"),
    callId: CallID,
    code: Schema.String,
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("notify"), method: Schema.String, value: Schema.Json }),
])
export type HostCommand = typeof HostCommand.Type

/** Worker → host events. Workers cannot report process exit; only the host transport can observe it. */
export const WorkerEvent = Schema.Union([
  Schema.Struct({ ...envelope, type: Schema.Literals(["hello", "ready", "drained", "disposed"]) }),
  Schema.Struct({ ...envelope, type: Schema.Literal("result"), requestId: RequestID, value: Schema.Json }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("rejected"),
    requestId: RequestID,
    code: RejectionCode,
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("failed"),
    phase: Schema.Literals(["readiness", "dispose", "protocol"]),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("host.call"),
    callId: CallID,
    method: Schema.String,
    value: Schema.Json,
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("notify"), method: Schema.String, value: Schema.Json }),
])
export type WorkerEvent = typeof WorkerEvent.Type

export const HostProcessErrorCode = Schema.Literals([
  "protocol",
  "readiness",
  "closed",
  "cancelled",
  "requestFailed",
  "exited",
  "capacity",
  "transport",
  "deadline",
  "denied",
])
export type HostProcessErrorCode = typeof HostProcessErrorCode.Type

/** Execution failure; uncertain stopping never grants permission to delete resources. */
export class HostProcessError extends Schema.TaggedErrorClass<HostProcessError>()("HostProcessError", {
  code: HostProcessErrorCode,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {
  override get message() {
    return `Extension host process failed: ${this.code}${this.detail ? ` (${this.detail})` : ""}`
  }
}

/**
 * Decode a worker event at the process boundary, including unknown-field rejection.
 * @param input Parsed JSON frame from the control channel.
 * @returns Valid protocol event; invalid versions and non-JSON payloads fail closed.
 */
export function decodeWorkerEvent(input: unknown): WorkerEvent {
  try {
    return Schema.decodeUnknownSync(WorkerEvent)(input, { onExcessProperty: "error" })
  } catch (cause) {
    throw new HostProcessError({ code: "protocol", cause })
  }
}

/**
 * Decode a host command before dispatching any worker action.
 * @param input Parsed JSON frame from the control channel.
 * @returns Valid protocol command or a structured protocol failure.
 */
export function decodeHostCommand(input: unknown): HostCommand {
  try {
    return Schema.decodeUnknownSync(HostCommand)(input, { onExcessProperty: "error" })
  } catch (cause) {
    throw new HostProcessError({ code: "protocol", cause })
  }
}

/** Validate and canonically serialize a command before it occupies queue budget. */
export function serializeCommand(command: HostCommand): string {
  return JSON.stringify(decodeHostCommand(command))
}

/** Validate and canonically serialize an event before it occupies queue budget. */
export function serializeEvent(event: WorkerEvent): string {
  return JSON.stringify(decodeWorkerEvent(event))
}

export * as HostProcessProtocol from "./protocol.ts"
