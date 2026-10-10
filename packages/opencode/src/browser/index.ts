import { Context, Effect, Layer, Schema } from "effect"
import type { Duration } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { BrowserBridge } from "./bridge"
import {
  type GptProCommand,
  type GptProJob,
  type GptProNotification,
} from "@opencode-ai/util/gpt-pro"
import { InstanceState } from "@/effect/instance-state"

export * as Browser from "./index"

// P2-S-01: tool-facing facade over the browser bridge. Tools never talk to the
// bridge directly: this module owns the session -> agent page mapping and
// translates wire-protocol results into typed values. The desktop side defaults
// missing page IDs to the user view, so every command here passes an explicit
// per-session agent page ID (`agent-browser-<sessionID>`, ephemeral profile). Recovery
// targets instead go through an owner-scoped GPT-Pro broker, never arbitrary partitions.

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

const mapError = (error: BrowserBridge.CommandError | BrowserError): BrowserError =>
  error._tag === "BrowserBridge.AbsentError" ? new NotConnectedError() : error

export const Screenshot = Schema.Struct({
  data: Schema.String,
  mime: Schema.String,
})
export type Screenshot = typeof Screenshot.Type
export type Target = { readonly consultationID?: string }
export const ConsultationParameter = Schema.optional(Schema.String).annotate({
  description:
    "GPT-Pro consultation_id. Targets only that owned consultation's browser. Read-only inspection remains available during tracking; changes require an active recovery handoff.",
})

export interface Interface {
  readonly gptPro: (owner: string, input: GptProCommand) => Effect.Effect<GptProJob, BrowserError>
  /** Internal session-stop hook; callers supply identity resolved from session storage, never tool input. */
  readonly cancelGptProOwner: (directory: string, sessionID: string) => Effect.Effect<number, BrowserError>
  readonly gptProNotifications: (directory: string) => Effect.Effect<GptProNotification[], BrowserError>
  readonly gptProAcknowledge: (directory: string, ids: string[]) => Effect.Effect<void, BrowserError>
  /** Legacy page ID / Electron profile backing this session's browser view. */
  readonly partition: (sessionID: string) => string
  /** Current view state, or undefined when this session has no open page. */
  readonly state: (sessionID: string, target?: Target) => Effect.Effect<ViewState | undefined, BrowserError>
  /** Current view state, failing with NotOpenError when no page is open. */
  readonly requireState: (sessionID: string, target?: Target) => Effect.Effect<ViewState, BrowserError | NotOpenError>
  readonly navigate: (
    sessionID: string,
    url: string,
    options?: Target & { readonly timeout?: Duration.Input },
  ) => Effect.Effect<ViewState, BrowserError>
  readonly snapshot: (
    sessionID: string,
    options?: Target & { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Snapshot, BrowserError>
  readonly screenshot: (
    sessionID: string,
    options?: Target & { readonly fullPage?: boolean; readonly timeout?: Duration.Input },
  ) => Effect.Effect<Screenshot, BrowserError>
  readonly click: (
    sessionID: string,
    uid: string,
    options?: Target & {
      readonly timeout?: Duration.Input
      readonly position?: { readonly x: number; readonly y: number }
    },
  ) => Effect.Effect<ViewState | undefined, BrowserError>
  readonly type: (
    sessionID: string,
    uid: string,
    text: string,
    options?: Target & { readonly clear?: boolean; readonly submit?: boolean; readonly timeout?: Duration.Input },
  ) => Effect.Effect<ViewState | undefined, BrowserError>
  /**
   * Scroll the agent view: with `uid`, bring that element into view; otherwise
   * wheel the page in `direction` by `amount` px (defaults to ~one viewport).
   */
  readonly scroll: (
    sessionID: string,
    options?: Target & {
      readonly uid?: string
      readonly direction?: "up" | "down"
      readonly amount?: number
      readonly timeout?: Duration.Input
    },
  ) => Effect.Effect<ViewState | undefined, BrowserError>
  /**
   * Console entries captured from the agent page. Without `options.since`
   * this is incremental per session: each call returns entries newer than the
   * previous call's and advances the cursor.
   */
  readonly console: (
    sessionID: string,
    options?: Target & { readonly since?: number },
  ) => Effect.Effect<ConsoleEntry[], BrowserError>
  /**
   * Close this session's embedded browser view, freeing its resources. The
   * agent page is ephemeral — a later navigate reopens it fresh.
   */
  readonly close: (sessionID: string, target?: Target) => Effect.Effect<void, BrowserError>
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
          return Effect.fail(
            new BrowserBridge.CommandFailedError({ message: `invalid ${name} result: ${String(cause)}` }),
          )
        }
      })

    const command = <A>(
      name: string,
      args: Record<string, unknown>,
      decode: (result: unknown) => A,
      timeout: Duration.Input,
    ): Effect.Effect<A, BrowserError> =>
      bridge.command(name, args, { timeout }).pipe(
        Effect.flatMap((result) => decodeResult(name, decode, result)),
        Effect.mapError(mapError),
      )

    const targetCommand = <A>(
      sessionID: string,
      name: string,
      args: Record<string, unknown>,
      decode: (result: unknown) => A,
      timeout: Duration.Input,
      target?: Target,
    ): Effect.Effect<A, BrowserError> => {
      if (!target?.consultationID)
        return command(name, { ...args, pageID: agentPartition(sessionID) }, decode, timeout)
      return Effect.gen(function* () {
        const { directory } = yield* InstanceState.context
        return yield* command(
          "gpt-pro-browser",
          { owner: `${AppFileSystem.resolve(directory)}\n${sessionID}`, id: target.consultationID, name, args },
          decode,
          timeout,
        )
      })
    }

    return Service.of({
      gptProNotifications: (directory) =>
        command(
          "gpt-pro-notifications",
          { directory: AppFileSystem.resolve(directory) },
          (result) => {
            const decode = Schema.decodeUnknownSync(
              Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  consultationID: Schema.String,
                  owner: Schema.String,
                  phase: Schema.Literals([
                    "queued",
                    "preparing",
                    "sending",
                    "generating",
                    "completed",
                    "paused",
                    "cancelled",
                    "failed",
                    "interrupted",
                    "send_uncertain",
                  ]),
                  revision: Schema.Number,
                  at: Schema.Number,
                  url: Schema.String,
                  kind: Schema.Literals(["progress", "completed", "state"]),
                  format: Schema.Literals(["append", "snapshot"]),
                  text: Schema.String,
                  truncated: Schema.Boolean,
                  error: Schema.optional(Schema.String),
                  recovery: Schema.optional(
                    Schema.Struct({
                      stage: Schema.Literals(["open", "ready", "model", "compose", "submit", "track"]),
                      reason: Schema.String,
                      needsHuman: Schema.optional(Schema.Boolean),
                    }),
                  ),
                }),
              ),
            )
            return decode(result) as GptProNotification[]
          },
          "10 seconds",
        ),
      gptProAcknowledge: (directory, ids) =>
        command("gpt-pro-ack", { directory: AppFileSystem.resolve(directory), ids }, () => undefined, "10 seconds"),
      gptPro: (owner, input) =>
        command(
          "gpt-pro",
          { ...input, owner },
          (result) => {
            const job = result as GptProJob
            if (!job || typeof job.id !== "string" || typeof job.phase !== "string" || job.owner !== owner)
              throw new Error("Invalid consultation response")
            return job
          },
          "60 seconds",
        ),
      cancelGptProOwner: (directory, sessionID) =>
        command(
          "gpt-pro-cancel-owner",
          { directory: AppFileSystem.resolve(directory), sessionID },
          (result) => {
            const count = (result as { cancelled?: unknown })?.cancelled
            if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
              throw new Error("Invalid owner cancellation response")
            return count
          },
          "3 seconds",
        ),
      partition: (sessionID) => agentPartition(sessionID),

      state: (sessionID, target) =>
        targetCommand(sessionID, "state", {}, (result) => result as { state?: unknown }, "10 seconds", target).pipe(
          Effect.flatMap((result) => {
            const state = (result as { state?: unknown }).state
            if (!state) return Effect.succeed(undefined as ViewState | undefined)
            return decodeResult("state", decodeState, state)
          }),
          Effect.mapError(mapError),
        ),

      requireState: (sessionID, target) =>
        targetCommand(sessionID, "state", {}, (result) => result as { state?: unknown }, "10 seconds", target).pipe(
          Effect.flatMap((result): Effect.Effect<ViewState, BrowserError | NotOpenError> => {
            const state = (result as { state?: unknown }).state
            if (!state) return Effect.fail(new NotOpenError())
            return decodeResult("state", decodeState, state)
          }),
          Effect.mapError((error) =>
            error instanceof NotOpenError ? error : mapError(error as BrowserBridge.CommandError),
          ),
        ),

      navigate: (sessionID, url, options) =>
        targetCommand(
          sessionID,
          "navigate",
          { url },
          (result) => decodeState((result as { state: unknown }).state),
          options?.timeout ?? "60 seconds",
          options,
        ),

      snapshot: (sessionID, options) =>
        targetCommand(
          sessionID,
          "snapshot",
          {},
          (result) => decodeSnapshot((result as { snapshot: unknown }).snapshot),
          options?.timeout ?? "60 seconds",
          options,
        ),

      screenshot: (sessionID, options) =>
        targetCommand(
          sessionID,
          "screenshot",
          { fullPage: options?.fullPage === true },
          (result) => decodeScreenshot(result),
          options?.timeout ?? "30 seconds",
          options,
        ),

      click: (sessionID, uid, options) =>
        targetCommand(
          sessionID,
          "click",
          { uid, ...(options?.position ? { position: options.position } : {}) },
          (result) => result as { state?: unknown },
          options?.timeout ?? "30 seconds",
          options,
        ).pipe(
          Effect.flatMap((result) => {
            const state = (result as { state?: unknown }).state
            if (!state) return Effect.succeed(undefined as ViewState | undefined)
            return decodeResult("click", decodeState, state)
          }),
          Effect.mapError(mapError),
        ),

      type: (sessionID, uid, text, options) =>
        targetCommand(
          sessionID,
          "type",
          {
            uid,
            text,
            clear: options?.clear !== false,
            submit: options?.submit === true,
          },
          (result) => result as { state?: unknown },
          options?.timeout ?? "30 seconds",
          options,
        ).pipe(
          Effect.flatMap((result) => {
            const state = (result as { state?: unknown }).state
            if (!state) return Effect.succeed(undefined as ViewState | undefined)
            return decodeResult("type", decodeState, state)
          }),
          Effect.mapError(mapError),
        ),

      scroll: (sessionID, options) =>
        targetCommand(
          sessionID,
          "scroll",
          {
            uid: options?.uid,
            direction: options?.direction,
            amount: options?.amount,
          },
          (result) => result as { state?: unknown },
          options?.timeout ?? "15 seconds",
          options,
        ).pipe(
          Effect.flatMap((result) => {
            const state = (result as { state?: unknown }).state
            if (!state) return Effect.succeed(undefined as ViewState | undefined)
            return decodeResult("scroll", decodeState, state)
          }),
          Effect.mapError(mapError),
        ),

      console: (sessionID, options) => {
        const cursor = `${sessionID}:${options?.consultationID ?? "ordinary"}`
        const since = options?.since ?? lastConsoleAt.get(cursor) ?? 0
        const authorized: Effect.Effect<{ pageID: string; earliest: number }, BrowserError> = options?.consultationID
          ? targetCommand(
              sessionID,
              "state",
              {},
              (result) => {
                const response = result as {
                  consultationCreatedAt?: number
                  state?: { pageID?: string; partition?: string }
                }
                const pageID = response.state?.pageID ?? response.state?.partition
                if (typeof response.consultationCreatedAt !== "number" || typeof pageID !== "string")
                  throw new Error("Missing consultation console ownership boundary")
                return { pageID, earliest: response.consultationCreatedAt }
              },
              "10 seconds",
              options,
            )
          : Effect.succeed({ pageID: agentPartition(sessionID), earliest: 0 })
        return authorized.pipe(
          Effect.flatMap(({ pageID, earliest }) =>
            bridge.console(
              pageID,
              Math.max(since, earliest),
            ),
          ),
          Effect.map((entries) => {
            if (options?.since === undefined) {
              const max = entries.reduce((acc, entry) => Math.max(acc, entry.at), since)
              lastConsoleAt.set(cursor, max)
            }
            return entries
          }),
        )
      },

      close: (sessionID, target) => targetCommand(sessionID, "close", {}, () => undefined, "10 seconds", target),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(BrowserBridge.defaultLayer))
