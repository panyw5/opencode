import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
  type LanguageModelV3FinishReason,
  type LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import * as Log from "@opencode-ai/core/util/log"

export const COMMANDCODE_PROVIDER_ID = "commandcode"
export const COMMANDCODE_PACKAGE = "commandcode"
export const COMMANDCODE_API_BASE = "https://api.commandcode.ai"
export const COMMANDCODE_GENERATE_PATH = "/alpha/generate"
export const COMMANDCODE_VERSION = "1.28.1"
export const COMMANDCODE_MAX_OUTPUT_TOKENS = 64_000
export const COMMANDCODE_REQUEST_TIMEOUT_MS = 60_000
export const COMMANDCODE_STREAM_IDLE_TIMEOUT_MS = 300_000

const log = Log.create({ service: "provider.commandcode" })

export type CommandCodeModelEntry = {
  id: string
  name: string
  contextLength: number
}

export type CommandCodeLanguageModelOptions = {
  apiKey?: string
  apiBase?: string
  workingDirectory?: string
  fetchImpl?: typeof fetch
  streamIdleTimeoutMs?: number
}

type CommandCodeEvent = Record<string, unknown>

function textFromToolOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (!output || typeof output !== "object") return JSON.stringify(output)
  const value = output as { type?: string; value?: unknown }
  if (value.type === "text" || value.type === "error-text") return String(value.value ?? "")
  return JSON.stringify(value.value)
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {}
  }
  return {}
}

function imageData(data: string | Uint8Array): string {
  if (typeof data === "string") return data.replace(/^data:[^,]+,/, "")
  return Buffer.from(data).toString("base64")
}

function toCommandCodePrompt(prompt: LanguageModelV3Prompt) {
  const system: string[] = []
  const messages: unknown[] = []
  const toolCalls = new Set<string>()
  const toolResults = new Set<string>()
  const toolNames = new Map<string, string>()

  for (const message of prompt) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call") {
          toolCalls.add(part.toolCallId)
          toolNames.set(part.toolCallId, part.toolName)
        }
      }
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") toolResults.add(part.toolCallId)
      }
    }
  }
  const pairedToolCalls = new Set([...toolCalls].filter((id) => toolResults.has(id)))

  for (const message of prompt) {
    if (message.role === "system") {
      system.push(message.content)
      continue
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: message.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text }
          if (
            part.mediaType.startsWith("image/") &&
            (typeof part.data === "string" || part.data instanceof Uint8Array)
          ) {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: part.mediaType,
                data: imageData(part.data),
              },
            }
          }
          throw new Error(`Command Code does not support file input type ${part.mediaType}`)
        }),
      })
      continue
    }

    if (message.role === "assistant") {
      const content: unknown[] = []
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text })
        if (part.type === "tool-call" && pairedToolCalls.has(part.toolCallId)) {
          content.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: recordOrEmpty(part.input),
          })
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content })
      continue
    }

    if (message.role === "tool") {
      const content = message.content.flatMap((part) => {
        if (part.type !== "tool-result" || !pairedToolCalls.has(part.toolCallId)) return []
        return [
          {
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: toolNames.get(part.toolCallId) ?? part.toolName ?? "unknown",
            output: { type: "text", value: textFromToolOutput(part.output) },
          },
        ]
      })
      if (content.length > 0) messages.push({ role: "tool", content })
    }
  }

  return { system: system.join("\n\n"), messages }
}

function toCommandCodeTools(options: LanguageModelV3CallOptions) {
  return (options.tools ?? [])
    .filter((tool) => tool.type === "function")
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
}

function reasoningEffort(options: LanguageModelV3CallOptions): string | undefined {
  for (const value of Object.values(options.providerOptions ?? {})) {
    if (!value || typeof value !== "object") continue
    const record = value as Record<string, unknown>
    if (typeof record.reasoningEffort === "string") return record.reasoningEffort
    if (typeof record.reasoning_effort === "string") return record.reasoning_effort
  }
  return undefined
}

function parseEvent(line: string): CommandCodeEvent | undefined {
  let json = line.trim()
  if (!json || json.startsWith(":") || json.startsWith("event:")) return undefined
  if (json.startsWith("data:")) json = json.slice(5).trim()
  if (!json || json === "[DONE]") return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === "object" ? (parsed as CommandCodeEvent) : undefined
  } catch {
    return undefined
  }
}

function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

function finishReason(value: unknown): LanguageModelV3FinishReason {
  if (value === "tool-calls") return { unified: "tool-calls", raw: "tool-calls" }
  if (value === "length" || value === "max_tokens" || value === "max_output_tokens") {
    return { unified: "length", raw: String(value) }
  }
  if (value === "stop") return { unified: "stop", raw: "stop" }
  return { unified: "other", raw: typeof value === "string" ? value : undefined }
}

function usage(value: unknown) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const inputTokens = typeof record.inputTokens === "number" ? record.inputTokens : undefined
  const outputTokens = typeof record.outputTokens === "number" ? record.outputTokens : undefined
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  }
}

function requestBody(modelId: string, input: LanguageModelV3CallOptions, workingDirectory: string) {
  const prompt = toCommandCodePrompt(input.prompt)
  const effort = reasoningEffort(input)
  return {
    config: {
      workingDir: workingDirectory,
      date: new Date().toISOString().slice(0, 10),
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: modelId,
      messages: prompt.messages,
      tools: toCommandCodeTools(input),
      system: prompt.system,
      max_tokens: Math.min(input.maxOutputTokens ?? COMMANDCODE_MAX_OUTPUT_TOKENS, COMMANDCODE_MAX_OUTPUT_TOKENS),
      temperature: input.temperature ?? 0.3,
      stream: true,
      ...(effort ? { reasoning_effort: effort } : {}),
    },
    threadId: crypto.randomUUID(),
  }
}

function modelContentPart(part: LanguageModelV3StreamPart): LanguageModelV3Content | undefined {
  if (part.type === "text-delta") return { type: "text", text: part.delta }
  if (part.type === "reasoning-delta") return { type: "reasoning", text: part.delta }
  if (part.type === "tool-call") return part
  return undefined
}

export function createCommandCodeLanguageModel(
  modelId: string,
  options: CommandCodeLanguageModelOptions,
): LanguageModelV3 {
  const fetchImpl = options.fetchImpl ?? fetch
  const apiBase = options.apiBase ?? COMMANDCODE_API_BASE
  const workingDirectory = options.workingDirectory ?? process.cwd()
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? COMMANDCODE_STREAM_IDLE_TIMEOUT_MS

  const headers = (extra?: Record<string, string | undefined>) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.apiKey ?? ""}`,
    "x-command-code-version": COMMANDCODE_VERSION,
    "x-cli-environment": "production",
    "x-project-slug": projectSlugFromPath(workingDirectory),
    "x-taste-learning": "true",
    "x-co-flag": "false",
    ...Object.fromEntries(Object.entries(extra ?? {}).filter(([, value]) => value !== undefined)),
  })

  const doStream = async (input: LanguageModelV3CallOptions) => {
    const request = requestBody(modelId, input, workingDirectory)
    log.info("starting Command Code request", { model: modelId, workingDirectory })
    const connectAbort = new AbortController()
    let connectTimedOut = false
    const connectTimer = setTimeout(() => {
      connectTimedOut = true
      connectAbort.abort(
        new DOMException(
          `Command Code API request did not respond within ${COMMANDCODE_REQUEST_TIMEOUT_MS}ms`,
          "TimeoutError",
        ),
      )
    }, COMMANDCODE_REQUEST_TIMEOUT_MS)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let streamCancelled = false
    const onCallerAbort = () => {
      connectAbort.abort(input.abortSignal?.reason)
      void reader?.cancel(input.abortSignal?.reason).catch(() => undefined)
    }
    input.abortSignal?.addEventListener("abort", onCallerAbort, { once: true })
    const cleanupConnection = () => {
      clearTimeout(connectTimer)
      input.abortSignal?.removeEventListener("abort", onCallerAbort)
    }

    let response: Response
    try {
      response = await fetchImpl(`${apiBase}${COMMANDCODE_GENERATE_PATH}`, {
        method: "POST",
        headers: headers(input.headers),
        body: JSON.stringify(request),
        signal: connectAbort.signal,
      })
      clearTimeout(connectTimer)
    } catch (error) {
      cleanupConnection()
      if (input.abortSignal?.aborted) throw error
      if (connectTimedOut) {
        throw new Error(`Command Code API request did not respond within ${COMMANDCODE_REQUEST_TIMEOUT_MS}ms`)
      }
      throw new Error(`Command Code API request failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    log.info("received Command Code response", { model: modelId, status: response.status })

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 1000)
      cleanupConnection()
      throw new Error(`Command Code API error ${response.status}${detail ? `: ${detail}` : ""}`)
    }
    if (!response.body) {
      cleanupConnection()
      throw new Error("Command Code API returned no response body")
    }
    reader = response.body.getReader()

    const cancelReader = (reason?: unknown) => {
      log.warn("cancelling Command Code stream", {
        model: modelId,
        reason: reason instanceof Error ? reason.message : String(reason ?? "unknown"),
      })
      return reader?.cancel(reason).catch(() => undefined)
    }

    const streamParts = async function* (): AsyncGenerator<LanguageModelV3StreamPart> {
      const decoder = new TextDecoder()
      let buffer = ""
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let idleFired = false
      let textID: string | undefined
      let reasoningID: string | undefined
      let textOpen = false
      let reasoningOpen = false
      let finished = false
      let finish = finishReason("stop")
      let totalUsage: unknown
      let sawContent = false

      const closeText = () => {
        if (!textOpen || !textID) return [] as LanguageModelV3StreamPart[]
        textOpen = false
        return [{ type: "text-end", id: textID } satisfies LanguageModelV3StreamPart]
      }
      const closeReasoning = () => {
        if (!reasoningOpen || !reasoningID) return [] as LanguageModelV3StreamPart[]
        reasoningOpen = false
        return [{ type: "reasoning-end", id: reasoningID } satisfies LanguageModelV3StreamPart]
      }
      const handleEvent = (event: CommandCodeEvent | undefined): LanguageModelV3StreamPart[] => {
        if (!event) return []
        const type = event.type
        log.info("parsed Command Code stream event", { model: modelId, type: String(type) })
        if (type === "reasoning-start") return closeText()
        if (type === "reasoning-delta") {
          const parts = closeText()
          reasoningID ??= generateId()
          if (!reasoningOpen) {
            reasoningOpen = true
            parts.push({ type: "reasoning-start", id: reasoningID })
          }
          const delta = typeof event.text === "string" ? event.text : ""
          sawContent ||= delta.length > 0
          parts.push({ type: "reasoning-delta", id: reasoningID, delta })
          return parts
        }
        if (type === "reasoning-end") return closeReasoning()
        if (type === "text-delta") {
          const parts = closeReasoning()
          textID ??= generateId()
          if (!textOpen) {
            textOpen = true
            parts.push({ type: "text-start", id: textID })
          }
          const delta = typeof event.text === "string" ? event.text : ""
          sawContent ||= delta.length > 0
          parts.push({ type: "text-delta", id: textID, delta })
          return parts
        }
        if (type === "tool-call") {
          const parts = [...closeText(), ...closeReasoning()]
          const id = typeof event.toolCallId === "string" ? event.toolCallId : generateId()
          const name = typeof event.toolName === "string" ? event.toolName : "unknown"
          const rawInput = event.input ?? event.args ?? event.arguments
          const args = typeof rawInput === "string" ? rawInput : JSON.stringify(recordOrEmpty(rawInput))
          sawContent = true
          parts.push(
            { type: "tool-input-start", id, toolName: name },
            { type: "tool-input-delta", id, delta: args },
            { type: "tool-input-end", id },
            { type: "tool-call", toolCallId: id, toolName: name, input: args },
          )
          return parts
        }
        if (type === "finish") {
          finish = finishReason(event.finishReason)
          totalUsage = event.totalUsage
          finished = true
          return [
            ...closeText(),
            ...closeReasoning(),
            { type: "finish", finishReason: finish, usage: usage(totalUsage) },
          ]
        }
        if (type === "error") {
          const error = event.error
          const message =
            error && typeof error === "object" && "message" in error
              ? String(error.message)
              : typeof error === "string"
                ? error
                : typeof event.message === "string"
                  ? event.message
                  : "Command Code stream error"
          log.warn("Command Code stream error", { model: modelId, message })
          throw new Error(`Command Code stream error: ${message}`)
        }
        return []
      }

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleFired = true
          void reader?.cancel().catch(() => undefined)
        }, streamIdleTimeoutMs)
      }
      const clearIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = undefined
      }

      try {
        for (;;) {
          armIdle()
          try {
            const next = await reader.read()
            log.info("read Command Code stream chunk", {
              model: modelId,
              done: next.done,
              bytes: next.value?.byteLength ?? 0,
            })
            if (input.abortSignal?.aborted) {
              throw input.abortSignal.reason ?? new DOMException("Aborted", "AbortError")
            }
            if (streamCancelled) return
            if (next.done) {
              if (idleFired) throw new Error(`Command Code stream idle timeout after ${streamIdleTimeoutMs}ms`)
              if (buffer.trim()) {
                for (const part of handleEvent(parseEvent(buffer))) yield part
                buffer = ""
              }
              break
            }
            buffer += decoder.decode(next.value, { stream: true })
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ""
            for (const line of lines) {
              for (const part of handleEvent(parseEvent(line))) yield part
              if (finished) break
            }
            if (finished) break
          } catch (error) {
            if (streamCancelled && !input.abortSignal?.aborted) return
            throw error
          } finally {
            clearIdle()
          }
        }

        if (!finished) {
          yield* closeText()
          yield* closeReasoning()
          if (!sawContent) throw new Error("Command Code returned an empty response")
          yield { type: "finish", finishReason: finishReason("stop"), usage: usage(totalUsage) }
        }
      } finally {
        clearIdle()
        cleanupConnection()
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        void (async () => {
          try {
            for await (const part of streamParts()) controller.enqueue(part)
            if (!streamCancelled) controller.close()
          } catch (error) {
            log.warn("Command Code stream failed", {
              model: modelId,
              message: error instanceof Error ? error.message : String(error),
            })
            if (!streamCancelled) controller.error(error)
          }
        })()
      },
      async cancel(reason) {
        streamCancelled = true
        await cancelReader(reason)
      },
    })

    return { stream, request: { body: request } }
  }

  return {
    specificationVersion: "v3",
    provider: COMMANDCODE_PROVIDER_ID,
    modelId,
    supportedUrls: {},
    doStream,
    async doGenerate(input) {
      const result = await doStream(input)
      const reader = result.stream.getReader()
      const content: LanguageModelV3Content[] = []
      let finish = finishReason("stop")
      let tokenUsage: LanguageModelV3Usage = usage(undefined)
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const part = next.value
          const value = modelContentPart(part)
          if (value) {
            const current = content.at(-1)
            if (value.type === "text" && current?.type === "text") current.text += value.text
            else if (value.type === "reasoning" && current?.type === "reasoning") current.text += value.text
            else content.push(value)
          }
          if (part.type === "finish") {
            finish = part.finishReason
            tokenUsage = part.usage
          }
        }
      } finally {
        reader.releaseLock()
      }
      return {
        content,
        finishReason: finish,
        usage: tokenUsage,
        warnings: [],
        request: result.request,
      }
    },
  }
}

export * as CommandCode from "./commandcode"
