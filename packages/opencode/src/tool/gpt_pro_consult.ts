import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./gpt_pro_consult.txt"
import { Browser } from "@/browser"
import { InstanceState } from "@/effect/instance-state"
import { gptProTerminal, type GptProJob } from "@opencode-ai/util/gpt-pro"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.gpt_pro_consult" })
const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["consult", "status", "read", "open", "stop", "pause", "resume", "intervene", "background"]),
  ),
  consultation_id: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  wait_ms: Schema.optional(Schema.Number),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run asynchronously and continue your own exploration. New progress and completion are injected automatically. Do not sleep, poll or resend.",
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
        return Effect.gen(function* () {
          const action = params.action ?? "consult"
          yield* ctx.ask({
            permission: "gpt_pro_consult",
            patterns: ["gpt-pro"],
            always: ["gpt-pro"],
            metadata: { action, consultation_id: params.consultation_id, promptChars: params.prompt?.length ?? 0 },
          })
          const directory = (yield* InstanceState.context).directory
          const owner = `${directory}\n${ctx.sessionID}`
          const metadata = (job: GptProJob) => ({
            consultation_id: job.id,
            phase: job.phase,
            url: job.url,
            model: job.model,
            preview: job.prompt.slice(0, 160),
            revision: job.revision,
            error: job.error,
            text: job.text,
            background: job.background === true,
          })
          log.info("gpt-pro command", { action, sessionID: ctx.sessionID, consultationID: params.consultation_id })
          let job = yield* browser.gptPro(owner, {
            action,
            id: params.consultation_id,
            prompt: params.prompt,
            requestID: ctx.callID ? `${ctx.sessionID}:${ctx.callID}` : undefined,
            background: params.background,
          })
          active = { owner, id: job.id, background: job.background === true }
          const shouldWait =
            ["consult", "intervene", "resume"].includes(action) || (action === "status" && params.wait_ms !== undefined)
          const waitMs = Math.min(1800000, Math.max(0, params.wait_ms ?? 300000))
          const deadline = Date.now() + waitMs
          while (
            shouldWait &&
            !job.background &&
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
            url: job.url,
            model: job.model,
            error: job.error,
            background: job.background === true,
            ...(job.phase === "completed"
              ? { text: job.text, html: job.html }
              : {
                  partial_text: job.text,
                  instruction: job.background
                    ? "The consultation is running independently. Progress and completion are injected automatically. Continue your own exploration; do not sleep, poll or resend. Partial output is not final."
                    : gptProTerminal(job.phase) && job.phase !== "paused"
                      ? "The consultation did not complete. Report its error, do not claim an answer, and do not automatically resubmit. Resolve browser verification, login or network access before a new explicit consultation."
                      : "Use status with consultation_id to wait or read. Do not resubmit. Paused/partial output is not a final answer.",
                }),
          })
          return { title: "GPT-6 Pro", output, metadata: metadata(job) }
        }).pipe(
          Effect.onInterrupt(() => stopForeground),
          Effect.orDie,
        )
      },
    }
  }),
)
