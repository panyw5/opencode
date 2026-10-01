import { Context, Effect, Layer, Schema } from "effect"
import type { Duration } from "effect"
import { BrowserBridge } from "./bridge"

export * as Browser from "./index"

// P2-S-01: tool-facing facade over the browser bridge. Tools never talk to the
// bridge directly: this module owns the session -> agent partition mapping and
// translates wire-protocol results into typed values. The desktop side defaults
// missing partitions to the user view, so every command here passes an explicit
// per-session agent partition (`agent-browser-<sessionID>`, ephemeral).

// Canonical agent partition naming, mirrored in
// packages/desktop/src/main/browser.ts (owner of the views) and referenced
// via AGENT_PARTITION_PREFIX in packages/app/src/pages/session/browser-panel.tsx
// (renderer). Keep the three definitions in sync.
export const agentPartition = (sessionID: string) => `agent-browser-${sessionID}`

/** Raised when no desktop app is connected to the browser bridge. */
export class NotConnectedError extends Schema.TaggedErrorClass<NotConnectedError>()("BrowserNotConnectedError", {}) {
  override get message() {
    return (
      "The embedded browser is unavailable: no desktop app is connected to the browser bridge. " +
      "Browser tools require the opencode desktop app; they do not work in headless/CLI/remote sessions. " +
      "Tell the user to open the desktop app, then retry."
    )
  }
}

/** Raised when the session has not navigated anywhere yet. */
export class NotOpenError extends Schema.TaggedErrorClass<NotOpenError>()("BrowserNotOpenError", {}) {
  override get message() {
    return "No page is open for this session yet. Call browser_navigate with a URL first."
  }
}

export type ViewState = BrowserBridge.ViewState
export type ConsoleEntry = BrowserBridge.ConsoleEntry

export const SnapshotNode = Schema.Struct({
  uid: Schema.String,
  role: Schema.String,
  name: Schema.String,
  value: Schema.optional(Schema.String),
  focused: Schema.optional(Schema.Boolean),
})

export const Snapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  nodes: Schema.Array(SnapshotNode),
})
export type Snapshot = typeof Snapshot.Type

export type BrowserError = NotConnectedError | BrowserBridge.TimeoutError | BrowserBridge.CommandFailedError

const mapError = (error: BrowserBridge.CommandError): BrowserError =>
  error._tag === "BrowserBridge.AbsentError" ? new NotConnectedError() : error

export const Screenshot = Schema.Struct({
  data: Schema.String,
  mime: Schema.String,
})
export type Screenshot = typeof Screenshot.Type

export interface Interface {
  /** Ephemeral partition backing this session's browser view. */
  readonly partition: (sessionID: string) => string
  /** Current view state, or undefined when this session has no open page. */
  readonly state: (sessionID: string) => Effect.Effect<ViewState | undefined, BrowserError>
  /** Current view state, failing with NotOpenError when no page is open. */
  readonly requireState: (sessionID: string) => Effect.Effect<ViewState, BrowserError | NotOpenError>
  readonly navigate: (
    sessionID: string,
    url: string,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<ViewState, BrowserError>
  readonly snapshot: (
    sessionID: string,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Snapshot, BrowserError>
  readonly screenshot: (
    sessionID: string,
    options?: { readonly fullPage?: boolean; readonly timeout?: Duration.Input },
  ) => Effect.Effect<Screenshot, BrowserError>
  readonly click: (
    sessionID: string,
    uid: string,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<ViewState | undefined, BrowserError>
  readonly type: (
    sessionID: string,
    uid: string,
    text: string,
    options?: { readonly clear?: boolean; readonly submit?: boolean; readonly timeout?: Duration.Input },
  ) => Effect.Effect<ViewState | undefined, BrowserError>
  /**
   * Console entries captured from the agent partition. Without `options.since`
   * this is incremental per session: each call returns entries newer than the
   * previous call's and advances the cursor.
   */
  readonly console: (
    sessionID: string,
    options?: { readonly since?: number },
  ) => Effect.Effect<ConsoleEntry[], never>
  /**
   * Close this session's embedded browser view, freeing its resources. The
   * agent partition is ephemeral — a later navigate reopens it fresh.
   */
  readonly close: (sessionID: string) => Effect.Effect<void, BrowserError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Browser") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge.Service
    const lastConsoleAt = new Map<string, number>()

    const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
    const decodeScreenshot = Schema.decodeUnknownSync(Screenshot)
    const decodeState = Schema.decodeUnknownSync(BrowserBridge.ViewState)

    // A mismatched command result must surface as a typed CommandFailedError,
    // not a defect: Schema.decodeUnknownSync throws synchronously, and a raw
    // throw inside Effect.map would die the caller's fiber with an unhelpful
    // error instead of the tool's structured failure message.
    const decodeResult = <A>(
      name: string,
      decode: (result: unknown) => A,
      result: unknown,
    ): Effect.Effect<A, BrowserBridge.CommandFailedError> =>
      Effect.suspend(() => {
        try {
          return Effect.succeed(decode(result))
        } catch (cause) {
          return Effect.fail(new BrowserBridge.CommandFailedError({ message: `invalid ${name} result: ${String(cause)}` }))
        }
      })

    const command = <A>(
      name: string,
      args: Record<string, unknown>,
      decode: (result: unknown) => A,
      timeout: Duration.Input,
    ): Effect.Effect<A, BrowserError> =>
      bridge
        .command(name, args, { timeout })
        .pipe(Effect.flatMap((result) => decodeResult(name, decode, result)), Effect.mapError(mapError))

    return Service.of({
      partition: (sessionID) => agentPartition(sessionID),

      state: (sessionID) =>
        bridge.command("state", { partition: agentPartition(sessionID) }, { timeout: "10 seconds" }).pipe(
          Effect.flatMap((result) => {
            const state = (result as { state?: unknown }).state
            if (!state) return Effect.succeed(undefined as ViewState | undefined)
            return decodeResult("state", decodeState, state)
          }),
          Effect.mapError(mapError),
        ),

      requireState: (sessionID) =>
        bridge.command("state", { partition: agentPartition(sessionID) }, { timeout: "10 seconds" }).pipe(
          Effect.flatMap(
            (result): Effect.Effect<ViewState, BrowserError | NotOpenError> => {
              const state = (result as { state?: unknown }).state
              if (!state) return Effect.fail(new NotOpenError())
              return decodeResult("state", decodeState, state)
            },
          ),
          Effect.mapError((error) =>
            error instanceof NotOpenError ? error : mapError(error as BrowserBridge.CommandError),
          ),
        ),

      navigate: (sessionID, url, options) =>
        command(
          "navigate",
          { url, partition: agentPartition(sessionID) },
          (result) => decodeState((result as { state: unknown }).state),
          options?.timeout ?? "60 seconds",
        ),

      snapshot: (sessionID, options) =>
        command(
          "snapshot",
          { partition: agentPartition(sessionID) },
          (result) => decodeSnapshot((result as { snapshot: unknown }).snapshot),
          options?.timeout ?? "60 seconds",
        ),

      screenshot: (sessionID, options) =>
        command(
          "screenshot",
          { partition: agentPartition(sessionID), fullPage: options?.fullPage === true },
          (result) => decodeScreenshot(result),
          options?.timeout ?? "30 seconds",
        ),

      click: (sessionID, uid, options) =>
        bridge
          .command("click", { uid, partition: agentPartition(sessionID) }, { timeout: options?.timeout ?? "30 seconds" })
          .pipe(
            Effect.flatMap((result) => {
              const state = (result as { state?: unknown }).state
              if (!state) return Effect.succeed(undefined as ViewState | undefined)
              return decodeResult("click", decodeState, state)
            }),
            Effect.mapError(mapError),
          ),

      type: (sessionID, uid, text, options) =>
        bridge
          .command(
            "type",
            {
              uid,
              text,
              partition: agentPartition(sessionID),
              clear: options?.clear !== false,
              submit: options?.submit === true,
            },
            { timeout: options?.timeout ?? "30 seconds" },
          )
          .pipe(
            Effect.flatMap((result) => {
              const state = (result as { state?: unknown }).state
              if (!state) return Effect.succeed(undefined as ViewState | undefined)
              return decodeResult("type", decodeState, state)
            }),
            Effect.mapError(mapError),
          ),

      console: (sessionID, options) => {
        const since = options?.since ?? lastConsoleAt.get(sessionID) ?? 0
        return Effect.map(bridge.console(agentPartition(sessionID), since), (entries) => {
          if (options?.since === undefined) {
            const max = entries.reduce((acc, entry) => Math.max(acc, entry.at), since)
            lastConsoleAt.set(sessionID, max)
          }
          return entries
        })
      },

      close: (sessionID) =>
        command("close", { partition: agentPartition(sessionID) }, () => undefined, "10 seconds"),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(BrowserBridge.defaultLayer))
