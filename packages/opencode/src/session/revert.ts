import { Effect, Exit, Layer, Context, Schema } from "effect"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "../sync"
import * as Log from "@opencode-ai/core/util/log"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { SessionHistory } from "./history"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError | Storage.NotFoundError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service
    const history = yield* SessionHistory.Service

    const revertUnlocked = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      log.info("revert start", input)
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const target = all.findIndex((msg) => msg.info.id === input.messageID)
      const part = input.partID ? all[target]?.parts.findIndex((part) => part.id === input.partID) : undefined
      if (target < 0 || part === -1) {
        log.warn("revert boundary not found", { ...input, messages: all.length })
        return yield* new Storage.NotFoundError({
          message: `Revert boundary not found: ${input.messageID}${input.partID ? `/${input.partID}` : ""}`,
        })
      }
      const message = all[target]
      const partial =
        part !== undefined && message.parts.slice(0, part).some((part) => part.type === "text" || part.type === "tool")
      const parentID = message.info.role === "assistant" ? message.info.parentID : message.info.id
      const parent = all.findIndex((msg) => msg.info.id === parentID && msg.info.role === "user")
      const boundary = partial ? target : parent >= 0 ? parent : target
      const rev: NonNullable<Session.Info["revert"]> = {
        messageID: all[boundary].info.id,
        ...(partial ? { partID: input.partID } : {}),
      }
      const range = all.slice(boundary)
      const patches = range.flatMap((msg, index) =>
        (index === 0 && partial ? msg.parts.slice(part) : msg.parts).filter(
          (part): part is Snapshot.Patch & MessageV2.Part => part.type === "patch",
        ),
      )
      yield* state.invalidate(input.sessionID)
      yield* summary.invalidate(input.sessionID)

      log.info("revert boundary resolved", {
        sessionID: input.sessionID,
        requestedMessageID: input.messageID,
        requestedPartID: input.partID,
        messageID: rev.messageID,
        partID: rev.partID,
        messages: all.length,
        patches: patches.length,
      })

      const checkpoint = yield* snap.track()
      let committed = false
      return yield* Effect.gen(function* () {
        rev.snapshot = session.revert?.snapshot ?? checkpoint
        if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
        yield* snap.revert(patches)
        if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
        const diffs = yield* summary.computeDiff({ messages: range })
        yield* sessions.setRevert({
          sessionID: input.sessionID,
          revert: rev,
          summary: {
            additions: diffs.reduce((sum, x) => sum + x.additions, 0),
            deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            files: diffs.length,
          },
        })
        committed = true
        yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
        yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
        const result = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        log.info("revert complete", {
          sessionID: input.sessionID,
          messageID: result.revert?.messageID,
          partID: result.revert?.partID,
        })
        return result
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit) || committed || !checkpoint) return Effect.void
          log.warn("revert failed before commit; restoring checkpoint", { sessionID: input.sessionID, checkpoint })
          return snap.restore(checkpoint).pipe(
            Effect.tap(() => Effect.sync(() => log.info("revert checkpoint restored", { sessionID: input.sessionID }))),
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                log.error("revert checkpoint restore failed", { sessionID: input.sessionID, cause: String(cause) }),
              ),
            ),
          )
        }),
      )
    })

    const unrevertUnlocked = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      const reverted = session.revert
      yield* state.invalidate(input.sessionID)
      yield* summary.invalidate(input.sessionID)
      const checkpoint = yield* snap.track()
      let committed = false
      return yield* Effect.gen(function* () {
        if (reverted.snapshot) yield* snap.restore(reverted.snapshot)
        yield* sessions.clearRevert(input.sessionID)
        committed = true
        return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit) || committed || !checkpoint) return Effect.void
          log.warn("unrevert failed before commit; restoring checkpoint", { sessionID: input.sessionID, checkpoint })
          return snap
            .restore(checkpoint)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error("unrevert checkpoint restore failed", { sessionID: input.sessionID, cause: String(cause) }),
                ),
              ),
            )
        }),
      )
    })

    const cleanupUnlocked = Effect.fn("SessionRevert.cleanup")(function* (input: Session.Info) {
      const session = yield* sessions.get(input.id).pipe(Effect.orDie)
      if (!session.revert) return
      const sessionID = session.id
      yield* summary.invalidate(sessionID)
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const index = msgs.findIndex((msg) => msg.info.id === messageID)
      const target = msgs[index]
      const partIndex = session.revert.partID
        ? target?.parts.findIndex((part) => part.id === session.revert!.partID)
        : undefined
      if (index < 0 || partIndex === -1) {
        log.error("cleanup boundary missing; refusing to guess suffix", {
          sessionID,
          messageID,
          partID: session.revert.partID,
        })
        return yield* Effect.die(new Storage.NotFoundError({ message: `Cleanup boundary not found: ${messageID}` }))
      }
      // Delete the boundary last, so interrupted cleanup still has an exact anchor.
      const remove = msgs.slice(index + (session.revert.partID ? 1 : 0)).reverse()
      log.info("cleanup start", {
        sessionID,
        messageID,
        partID: session.revert.partID,
        messages: msgs.length,
        removeMessages: remove.length,
      })
      for (const msg of remove) {
        log.info("cleanup remove message", { sessionID, messageID: msg.info.id })
        yield* sync.run(
          MessageV2.Event.Removed,
          {
            sessionID,
            messageID: msg.info.id,
          },
          { awaitPublish: true },
        )
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            log.info("cleanup remove part", { sessionID, messageID: target.info.id, partID: part.id })
            yield* sync.run(
              MessageV2.Event.PartRemoved,
              {
                sessionID,
                messageID: target.info.id,
                partID: part.id,
              },
              { awaitPublish: true },
            )
          }
        }
      }
      log.info("cleanup clear revert", { sessionID, messageID, removeMessages: remove.length })
      yield* sessions.clearRevert(sessionID, { awaitPublish: true })
      log.info("cleanup complete", { sessionID, messageID, removeMessages: remove.length })
    })

    const revert = (input: RevertInput) =>
      history.withLock(input.sessionID, revertUnlocked(input).pipe(Effect.uninterruptible))
    const unrevert = (input: { sessionID: SessionID }) =>
      history.withLock(input.sessionID, unrevertUnlocked(input).pipe(Effect.uninterruptible))
    const cleanup = (input: Session.Info) =>
      history.withLock(input.id, cleanupUnlocked(input).pipe(Effect.uninterruptible))
    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
    Layer.provide(SessionHistory.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
