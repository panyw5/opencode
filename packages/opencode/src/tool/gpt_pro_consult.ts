import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./gpt_pro_consult.txt"
import { Browser } from "@/browser"
import { InstanceState } from "@/effect/instance-state"
import { gptProTerminal, type GptProJob } from "@opencode-ai/util/gpt-pro"
import * as Log from "@opencode-ai/core/util/log"
import { prepareGptProAttachments } from "./gpt-pro-attachments"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const log = Log.create({ service: "tool.gpt_pro_consult" })
const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals([
      "consult",
      "status",
      "read",
      "open",
      "stop",
      "pause",
      "resume",
      "intervene",
      "background",
      "send",
    ]),
  ),
  consultation_id: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Local files to explicitly attach to this GPT-6 Pro consultation. Relative paths resolve from the workspace.",
  }),
  wait_ms: Schema.optional(Schema.Number),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run asynchronously and continue your own exploration. New progress and completion are injected automatically. Do not sleep, poll or resend.",
  }),
  uid: Schema.optional(Schema.String).annotate({
    description:
      "For recovery action=send, the send button uid observed with browser_read. The program validates the original prompt, model and single-send boundary.",
  }),
})

export const GptProConsultTool = Tool.define(
  "gpt_pro_consult",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => {
        let active: { owner: string; id: string; background: boolean } | undefined
        const stopForeground = Effect.gen(function* () {
          if (!active || active.background) return
          const current = yield* browser.gptPro(active.owner, { action: "status", id: active.id }).pipe(Effect.option)
          // Promotion can race with a foreground waiter being interrupted.
          if (current._tag === "Some" && !current.value.background) {
            yield* browser.gptPro(active.owner, { action: "stop", id: active.id }).pipe(Effect.ignore)
          }
        })
        return Effect.scoped(
          Effect.gen(function* () {
            const action = params.action ?? "consult"
            const directory = AppFileSystem.resolve((yield* InstanceState.context).directory)
            const owner = `${directory}\n${ctx.sessionID}`
            const directParts = ctx.extra?.gptProAttachmentParts as readonly unknown[] | undefined
            if ((params.files?.length || directParts?.length) && action !== "consult" && action !== "intervene") {
              return yield* Effect.die(new Error("GPT-Pro files are only accepted for consult or intervene actions"))
            }
            const attachments = yield* prepareGptProAttachments(params.files, ctx, "GPT-6 Pro (ChatGPT)")
            const attachmentSummary = attachments.map(({ path: _path, ...attachment }) => ({
              ...attachment,
              status: "pending" as const,
            }))
            if (!attachments.length) {
              yield* ctx.ask({
                permission: "gpt_pro_consult",
                patterns: ["gpt-pro"],
                always: ["gpt-pro"],
                metadata: { action, consultation_id: params.consultation_id, promptChars: params.prompt?.length ?? 0 },
              })
            }
            log.info("gpt-pro request authorized", {
              action,
              sessionID: ctx.sessionID,
              attachments: attachments.map(({ name, size, mime }) => ({ name, size, mime })),
            })
            const metadata = (job: GptProJob) => ({
              consultation_id: job.id,
              phase: job.phase,
              queue_reason: job.queueReason,
              queue_owner_consultation_id: job.queueOwnerConsultationID,
              url: job.url,
              model: job.model,
              preview: job.prompt.slice(0, 160),
              revision: job.revision,
              error: job.error,
              error_code: job.errorCode,
              send_attempted: job.sendAttempted === true || job.submitted,
              user_id: job.userID,
              submitted: job.submitted,
              stop_pending: job.stopPending === true,
              text: job.text,
              background: job.background === true,
              recovery: job.recovery,
              attachments: job.attachments ?? attachmentSummary,
            })
            log.info("gpt-pro command", { action, sessionID: ctx.sessionID, consultationID: params.consultation_id })
            let job = yield* browser.gptPro(owner, {
              action,
              id: params.consultation_id,
              prompt: params.prompt,
              requestID: ctx.callID ? `${ctx.sessionID}:${ctx.callID}` : undefined,
              background: params.background,
              uid: params.uid,
              attachments: attachments.length ? attachments : undefined,
            })
            active = { owner, id: job.id, background: job.background === true }
            const shouldWait =
              ["consult", "intervene", "resume"].includes(action) ||
              (action === "status" && params.wait_ms !== undefined)
            const waitMs = Math.min(1800000, Math.max(0, params.wait_ms ?? 300000))
            const deadline = Date.now() + waitMs
            while (
              shouldWait &&
              !job.background &&
              !job.recovery &&
              (!gptProTerminal(job.phase) || job.phase === "paused") &&
              Date.now() < deadline
            ) {
              yield* ctx.metadata({ title: "GPT-6 Pro", metadata: metadata(job) })
              if (ctx.abort.aborted) {
                yield* stopForeground
                throw new Error("Consultation aborted")
              }
              yield* Effect.sleep("1 second")
              job = yield* browser.gptPro(owner, { action: "status", id: job.id })
              active.id = job.id
              active.background = job.background === true
            }
            if (job.phase === "completed") job = yield* browser.gptPro(owner, { action: "read", id: job.id })
            yield* ctx.metadata({ title: "GPT-6 Pro", metadata: metadata(job) })
            const output = JSON.stringify({
              consultation_id: job.id,
              phase: job.phase,
              queue_reason: job.queueReason,
              queue_owner_consultation_id: job.queueOwnerConsultationID,
              url: job.url,
              model: job.model,
              error: job.error,
              error_code: job.errorCode,
              background: job.background === true,
              stop_pending: job.stopPending === true,
              recovery: job.recovery,
              attachments: job.attachments ?? attachmentSummary,
              ...(job.recovery
                ? { managed_prompt: job.prompt, send_attempted: job.sendAttempted === true || job.submitted }
                : {}),
              ...(job.phase === "completed"
                ? { text: job.text, html: job.html }
                : {
                    partial_text: job.text,
                    instruction: job.stopPending
                      ? "This consultation is cancelled locally. Website generation stop is still being confirmed; do not claim the webpage has stopped. Inspect the original page or read this same consultation's status. Never resend."
                      : job.recovery
                        ? `The fixed flow failed at ${job.recovery.stage}. Use the existing browser_* tools with consultation_id=${job.id} to inspect and repair this consultation's page, then resume this same ID. Never create a replacement or resend an attempted question. The program owns managed prompt submission and tracking. ${job.recovery.needsHuman ? (job.errorCode === "login" ? "Human ChatGPT login is required; ask the user to reconnect their login before continuing." : "Human browser verification is required; do not automate the challenge.") : "You may use action=send after verifying the exact managed prompt and GPT-6 Pro; send is guarded against duplicates."}`
                        : gptProTerminal(job.phase) && job.phase !== "paused"
                          ? "The consultation did not complete. Report its error, do not claim an answer, and do not automatically resubmit. Resolve browser verification, login or network access before a new explicit consultation."
                          : job.background && job.phase !== "paused"
                            ? "The consultation is running independently. Progress and completion are injected automatically. Continue your own exploration; do not sleep, poll or resend. Partial output is not final."
                            : "Use status with consultation_id to wait or read. Do not resubmit. Paused/partial output is not a final answer.",
                  }),
            })
            log.info("gpt-pro command result", {
              action,
              sessionID: ctx.sessionID,
              consultationID: job.id,
              phase: job.phase,
              background: job.background === true,
              verifiedModel: job.model,
              hasError: !!job.error,
            })
            return { title: "GPT-6 Pro", output, metadata: metadata(job) }
          }).pipe(
            Effect.onInterrupt(() => stopForeground),
            Effect.orDie,
          ),
        )
      },
    }
  }),
)
