import { Schema } from "effect"

const uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
/** Identity of one lifecycle store, independent of its filesystem path. */
export const StoreID = uuid.pipe(Schema.brand("ExtensionLifecycleStoreID"))
/** Identity preserved across updates and destroyed by completed uninstall. */
export const InstallationID = uuid.pipe(Schema.brand("ExtensionInstallationID"))
/** Identity of one immutable deployment, not the legacy installId. */
export const GenerationID = uuid.pipe(Schema.brand("ExtensionGenerationID"))
/** Identity of one execution, never reused after restart. */
export const RuntimeID = uuid.pipe(Schema.brand("ExtensionRuntimeID"))
/** Identity of one lifecycle mutation. */
export const MutationID = uuid.pipe(Schema.brand("ExtensionMutationID"))
/** Exact integer counters reject overflow rather than reuse a fencing value. */
export const Counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
/** Every control message is tied to the store, deployment, execution and admission epoch. */
export const RuntimeIdentity = Schema.Struct({
  storeId: StoreID,
  installationId: InstallationID,
  generationId: GenerationID,
  runtimeId: RuntimeID,
  epoch: Counter,
})
export type RuntimeIdentity = typeof RuntimeIdentity.Type

const SnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  storeId: StoreID,
  installationId: InstallationID,
  generationId: GenerationID,
  revision: Counter,
  epoch: Counter,
  admission: Schema.Union([
    Schema.Struct({ status: Schema.Literal("open") }),
    Schema.Struct({ status: Schema.Literal("closing"), operationId: MutationID }),
  ]),
  runtimes: Schema.Array(
    Schema.Struct({ identity: RuntimeIdentity, state: Schema.Literals(["starting", "ready", "rootExited"]) }),
  ),
})
/** Prototype admission snapshot; not a replacement decoder or writer for registry v1-v3. */
export type AdmissionSnapshot = typeof SnapshotSchema.Type
/** Compare-and-swap coordinates read under the mutation guard. */
export type ExpectedRevision = Pick<AdmissionSnapshot, "storeId" | "revision">

/** State was not changed; callers must reload or keep the operation blocked. */
export class LifecycleStateError extends Error {
  readonly code: "invalid" | "conflict" | "closed" | "stale" | "overflow"
  constructor(code: LifecycleStateError["code"], options?: ErrorOptions) {
    super(`Extension lifecycle admission rejected: ${code}`, options)
    this.name = "LifecycleStateError"
    this.code = code
  }
}

function increment(value: number) {
  if (value === Number.MAX_SAFE_INTEGER) throw new LifecycleStateError("overflow")
  return value + 1
}

function checkRevision(state: AdmissionSnapshot, expected: ExpectedRevision) {
  if (state.storeId !== expected.storeId || state.revision !== expected.revision)
    throw new LifecycleStateError("conflict")
}

/**
 * Decode an isolated admission snapshot, rejecting unknown fields and inconsistent runtime ownership.
 * @param input Untrusted JSON read from a prototype snapshot, not an existing user registry.
 * @returns Validated snapshot. Malformed input never yields an empty/default store.
 */
export function decodeAdmission(input: unknown): AdmissionSnapshot {
  let state: AdmissionSnapshot
  try {
    state = Schema.decodeUnknownSync(SnapshotSchema)(input, { onExcessProperty: "error" })
  } catch (cause) {
    throw new LifecycleStateError("invalid", { cause })
  }
  const ids = new Set<string>()
  for (const runtime of state.runtimes) {
    const identity = runtime.identity
    if (
      ids.has(identity.runtimeId) ||
      identity.storeId !== state.storeId ||
      identity.installationId !== state.installationId ||
      identity.generationId !== state.generationId ||
      identity.epoch > state.epoch ||
      (state.admission.status === "open" && identity.epoch !== state.epoch)
    )
      throw new LifecycleStateError("invalid")
    ids.add(identity.runtimeId)
  }
  return state
}

/**
 * Record a starting reader while the caller holds mutation ownership, before releasing startup admission.
 * @param state Current validated snapshot.
 * @param expected Store identity and revision observed under the guard.
 * @param identity New execution identity; an already registered runtime cannot be reused.
 * @returns New snapshot to persist before acknowledging admission. This function performs no I/O.
 */
export function admitRuntime(
  state: AdmissionSnapshot,
  expected: ExpectedRevision,
  identity: RuntimeIdentity,
): AdmissionSnapshot {
  checkRevision(state, expected)
  if (state.admission.status !== "open") throw new LifecycleStateError("closed")
  if (
    identity.storeId !== state.storeId ||
    identity.installationId !== state.installationId ||
    identity.generationId !== state.generationId ||
    identity.epoch !== state.epoch ||
    state.runtimes.some((runtime) => runtime.identity.runtimeId === identity.runtimeId)
  )
    throw new LifecycleStateError("stale")
  return {
    ...state,
    revision: increment(state.revision),
    runtimes: [...state.runtimes, { identity, state: "starting" }],
  }
}

/**
 * Fence all existing execution replies and prevent subsequent starts.
 * @param state Current validated snapshot.
 * @param expected Store identity and revision observed under the mutation guard.
 * @param operationId Mutation whose persisted intent owns stopping these readers.
 * @returns Closing snapshot to persist before sending stop commands. Existing readers remain recorded.
 */
export function closeAdmission(
  state: AdmissionSnapshot,
  expected: ExpectedRevision,
  operationId: typeof MutationID.Type,
): AdmissionSnapshot {
  checkRevision(state, expected)
  if (state.admission.status === "closing") {
    if (state.admission.operationId === operationId) return state
    throw new LifecycleStateError("conflict")
  }
  return {
    ...state,
    revision: increment(state.revision),
    epoch: increment(state.epoch),
    admission: { status: "closing", operationId },
  }
}

/**
 * Check whether a business result or registration can still affect the admitted deployment.
 * @param state Latest snapshot, reloaded under mutation ownership before applying an effect.
 * @param identity Identity carried by a runtime message.
 * @returns False for closed admission, foreign identities, unregistered readers or stale epochs.
 */
export function acceptsRuntime(state: AdmissionSnapshot, identity: RuntimeIdentity): boolean {
  return (
    state.admission.status === "open" &&
    state.epoch === identity.epoch &&
    state.storeId === identity.storeId &&
    state.installationId === identity.installationId &&
    state.generationId === identity.generationId &&
    state.runtimes.some((runtime) => runtime.identity.runtimeId === identity.runtimeId && runtime.state === "ready")
  )
}

/**
 * Record readiness or an OS-observed root exit without inferring descendant termination.
 * @param state Current validated snapshot.
 * @param expected Store identity and revision read under mutation ownership.
 * @param identity Exact previously admitted identity, including its original epoch.
 * @param next Ready requires open admission; rootExited requires transport exit evidence, not a worker message.
 * @returns New snapshot. Root-exited entries remain recorded and do not authorize cleanup.
 */
export function recordRuntimeState(
  state: AdmissionSnapshot,
  expected: ExpectedRevision,
  identity: RuntimeIdentity,
  next: "ready" | "rootExited",
): AdmissionSnapshot {
  checkRevision(state, expected)
  const runtime = state.runtimes.find((entry) => entry.identity.runtimeId === identity.runtimeId)
  if (!runtime || !sameRuntime(runtime.identity, identity)) throw new LifecycleStateError("stale")
  if (
    next === "ready" &&
    (state.admission.status !== "open" || identity.epoch !== state.epoch || runtime.state === "rootExited")
  )
    throw new LifecycleStateError("closed")
  if (runtime.state === next) return state
  return {
    ...state,
    revision: increment(state.revision),
    runtimes: state.runtimes.map((entry) => (entry === runtime ? { ...entry, state: next } : entry)),
  }
}

/**
 * Compare the complete runtime fence, not a PID or runtimeId alone.
 * @param left Expected execution identity.
 * @param right Received execution identity.
 * @returns Whether all ownership and epoch fields match.
 */
export function sameRuntime(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return (
    left.storeId === right.storeId &&
    left.installationId === right.installationId &&
    left.generationId === right.generationId &&
    left.runtimeId === right.runtimeId &&
    left.epoch === right.epoch
  )
}

export * as LifecycleState from "./lifecycle-state.ts"
