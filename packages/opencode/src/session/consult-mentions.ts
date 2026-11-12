import { Cause, Effect } from "effect"
import { ulid } from "ulid"
import * as Log from "@opencode-ai/core/util/log"
import type { ModelID, ProviderID } from "@/provider/schema"
import { Permission } from "@/permission"
import type { Plugin } from "@/plugin"
import {
  buildConsultFollowupSynthetic,
  buildConsultPromptFromParts,
  consultMentionFor,
  isConsultMention,
} from "@/tool/consult-mention"
import type { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID } from "./schema"
import type { Session } from "./session"

const log = Log.create({ service: "session.consult-mentions" })

export type Outcome = { name: string; returned: boolean; error?: string; output?: string }

export type Result = {
  names: string[]
  outcomes: Outcome[]
  /** Instruction text for the agent that should summarize the consult output. */
  summary: string
}

export type Mode = "native" | "channel"

/**
 * Deterministically executes @codex/@claude/@grok/@dsh/@pi mention parts.
 * Native sessions let the primary agent summarize afterwards; channel sessions
 * inject the returned summary into the external agent prompt instead.
 */
export function runConsultMentions(
  deps: {
    sessions: Session.Interface
    registry: ToolRegistry.Interface
    permission: Permission.Interface
    plugin: Plugin.Interface
    directory: string
    worktree: string
  },
  input: {
    session: Session.Info
    lastUser: MessageV2.User
    msgs: MessageV2.WithParts[]
    lastUserParts: MessageV2.Part[]
    names: string[]
    agent: { name: string; permission: Permission.Ruleset }
    model: { id: ModelID; providerID: ProviderID }
    mode: Mode
  },
) {
  return Effect.gen(function* () {
    const { sessions } = deps
    const { session, lastUser, msgs, lastUserParts } = input
    const sessionID = session.id
    const uniqueNames = [...new Set(input.names.filter(isConsultMention))]
    if (uniqueNames.length === 0) return { names: [], outcomes: [], summary: "" } satisfies Result

    const gptProFileCount = uniqueNames.includes("gpt-pro")
      ? lastUserParts.filter((part) => part.type === "file").length
      : 0
    if (uniqueNames.includes("gpt-pro")) {
      log.info("direct GPT-Pro raw attachment parts forwarded", {
        phase: "consult-input",
        sessionID,
        messageID: lastUser.id,
        count: gptProFileCount,
        partIDs: lastUserParts.filter((part) => part.type === "file").map((part) => part.id),
      })
    }

    const allTools = yield* deps.registry.all()
    const toolByID = new Map(allTools.map((tool) => [tool.id, tool] as const))
    const consultOutcomes = new Map<string, { returned: boolean; error?: string; output?: string }>()

    const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: lastUser.id,
      sessionID,
      mode: lastUser.agent,
      agent: lastUser.agent,
      variant: lastUser.model.variant,
      path: { cwd: deps.directory, root: deps.worktree },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model.id,
      providerID: input.model.providerID,
      time: { created: Date.now() },
    })

    for (const name of uniqueNames) {
      const mention = consultMentionFor(name)
      if (!mention) continue
      const consultTool = toolByID.get(mention.tool)
      if (!consultTool) {
        log.error("consult tool missing from registry", { tool: mention.tool, sessionID })
        consultOutcomes.set(name, { returned: false, error: `Consult tool ${mention.tool} is unavailable` })
        continue
      }
      const backgroundChoice = lastUserParts.find(
        (part) => part.type === "text" && typeof part.metadata?.gptProBackground === "boolean",
      )
      const promptText =
        buildConsultPromptFromParts(lastUserParts, name !== "gpt-pro").trim() ||
        "The user requested an external consultation. Review the project context and provide structured analysis."
      const gptProAttachmentParts =
        name === "gpt-pro" ? lastUserParts.filter((part): part is MessageV2.FilePart => part.type === "file") : []
      const toolArgs = {
        prompt: promptText,
        ...(name === "gpt-pro" && backgroundChoice?.type === "text"
          ? { background: backgroundChoice.metadata!.gptProBackground as boolean }
          : {}),
      }

      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: mention.tool,
        state: {
          status: "running",
          input: toolArgs,
          time: { start: Date.now() },
        },
      })

      yield* deps.plugin.trigger(
        "tool.execute.before",
        { tool: mention.tool, sessionID, callID: part.id },
        { args: toolArgs },
      )

      let error: Error | undefined
      const consultAbort = new AbortController()
      let result: Tool.ExecuteResult | void = undefined
      result = yield* consultTool
        .execute(toolArgs, {
          agent: lastUser.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: consultAbort.signal,
          callID: part.callID,
          extra: name === "gpt-pro" ? { gptProAttachmentParts } : undefined,
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, unknown> }) =>
            Effect.gen(function* () {
              if (part.state.status !== "running") return
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: {
                  ...part.state,
                  ...(val.title === undefined ? {} : { title: val.title }),
                  ...(val.metadata === undefined ? {} : { metadata: { ...part.state.metadata, ...val.metadata } }),
                },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            deps.permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(input.agent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("consult mention execution failed", {
              error,
              advisor: name,
              tool: mention.tool,
              sessionID,
            })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                consultAbort.abort()
                if (part.state.status === "running") {
                  yield* sessions.abortToolPart({
                    sessionID,
                    messageID: assistantMessage.id,
                    partID: part.id,
                    source: "tool-specific-interrupt",
                    error: "Cancelled",
                    ownerMessageID: assistantMessage.id,
                  })
                }
              }),
            ),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* deps.plugin.trigger(
        "tool.execute.after",
        { tool: mention.tool, sessionID, callID: part.id, args: toolArgs },
        result,
      )

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!result) {
        const errorText = error?.message ?? "Tool execution failed"
        consultOutcomes.set(name, { returned: false, error: errorText })
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      } else {
        consultOutcomes.set(name, { returned: true, output: result.output })
      }
    }

    assistantMessage.finish = "tool-calls"
    assistantMessage.time.completed = Date.now()
    yield* sessions.updateMessage(assistantMessage)

    const gptProFailure = consultOutcomes.get("gpt-pro")
    const returned = [...consultOutcomes.keys()].filter((name) => consultOutcomes.get(name)?.returned)
    const summary =
      input.mode === "channel"
        ? channelFollowup(returned, uniqueNames, gptProFailure)
        : [
            ...(uniqueNames.includes("gpt-pro") && gptProFailure?.returned === false
              ? [
                  `GPT-Pro consultation failed: ${gptProFailure.error ?? "Tool execution failed"}. No advisor answer was returned. Explain this error accurately. Do not automatically retry or resend the request, do not upload only the remaining files, and do not replace the consultation with a local Read of the attachment.`,
                ]
              : []),
            ...(returned.length
              ? [buildConsultFollowupSynthetic(returned)]
              : uniqueNames.includes("gpt-pro") && gptProFailure?.returned === false
                ? []
                : [buildConsultFollowupSynthetic(uniqueNames)]),
          ].join("\n\n")

    // Native sessions need a synthetic user turn so the primary agent summarizes
    // the advisor output. Channel sessions receive the summary in their ACP prompt.
    if (input.mode === "native") {
      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: summary,
        synthetic: true,
      } satisfies MessageV2.TextPart)
    }

    return {
      names: uniqueNames,
      outcomes: [...consultOutcomes.entries()].map(([name, value]) => ({ name, ...value })),
      summary,
    } satisfies Result
  })
}

function channelFollowup(
  returned: string[],
  requested: string[],
  gptProFailure: { returned: boolean; error?: string } | undefined,
) {
  const labels = (names: string[]) =>
    names
      .map((name) => consultMentionFor(name)?.label ?? name)
      .filter(Boolean)
      .join(", ")
  return [
    returned.length
      ? `External consultations already ran for: ${labels(returned)}. Their results are in this conversation.`
      : `External consultations were requested for: ${labels(requested)}, but none returned a result.`,
    gptProFailure?.returned === false
      ? `GPT-Pro consultation failed: ${gptProFailure.error ?? "Tool execution failed"}.`
      : undefined,
    "Summarize the advisor output for the user and continue only if further action is needed.",
  ]
    .filter(Boolean)
    .join(" ")
}

export * as ConsultMentions from "./consult-mentions"
