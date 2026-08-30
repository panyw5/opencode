const MAX_PREFIX_BYTES = 1024 * 1024
const MAX_INPUT_CHUNK_BYTES = 1024 * 1024
const DIRECT_STREAM_THRESHOLD_BYTES = 1024 * 1024
const encoder = new TextEncoder()

export function canStreamRequestBody(input: {
  requestFormat: string
  providerFormat: string
  providerModel: string
  hasPayloadModifier: boolean
  alreadyBuffered: boolean
  contentLength?: number
}) {
  if (input.alreadyBuffered) return false
  if (input.requestFormat !== input.providerFormat) return false
  if (input.hasPayloadModifier) return false
  if (input.contentLength !== undefined && input.contentLength <= DIRECT_STREAM_THRESHOLD_BYTES) return false
  if (input.providerFormat !== "anthropic") return true
  return !(
    input.providerModel.startsWith("arn:aws:bedrock:") ||
    input.providerModel.startsWith("global.anthropic.") ||
    input.providerModel.startsWith("databricks-claude-")
  )
}

export function readRequestJson(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Response(passthrough([], body.getReader(), false, signal)).json()
}

export function streamRequestBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return passthrough([], body.getReader(), false, signal)
}

export function responseIsStreaming(requestFormat: string, googleRequestedStream: boolean, contentType: string | null) {
  if (requestFormat === "google") return googleRequestedStream
  const normalized = contentType?.toLowerCase() ?? ""
  return normalized.includes("text/event-stream") || normalized.includes("application/vnd.amazon.eventstream")
}

export async function prepareRequestBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  const scanner = new RootJsonScanner()
  let done = false
  const abort = () => void reader.cancel(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })

  try {
    while (!done && !scanner.model) {
      const next = await reader.read()
      done = next.done
      if (!next.value) continue
      if (next.value.length > MAX_INPUT_CHUNK_BYTES) {
        await reader.cancel("Request body chunk exceeds streaming limit")
        throw new Error("Request body chunk exceeds streaming limit")
      }
      const remaining = MAX_PREFIX_BYTES - scanner.offset
      scanner.push(next.value.subarray(0, Math.max(0, remaining)))
      if (!scanner.model && next.value.length > remaining) {
        await reader.cancel("Model field exceeds streaming prefix limit")
        throw new Error("Model field exceeds streaming prefix limit")
      }
      chunks.push(next.value)
    }
  } catch (error) {
    signal?.removeEventListener("abort", abort)
    await reader.cancel(error).catch(() => {})
    throw error
  }
  if (signal?.aborted) {
    signal.removeEventListener("abort", abort)
    await reader.cancel(signal.reason).catch(() => {})
    throw signal.reason ?? new DOMException("Aborted", "AbortError")
  }
  const found = scanner.model
  if (!found) {
    signal?.removeEventListener("abort", abort)
    await reader.cancel("Missing model field").catch(() => {})
    throw new Error("Missing model field")
  }
  let used = false

  const stream = (providerModel: string, includeUsage: boolean) => {
    if (used) throw new Error("Request body stream already consumed")
    used = true
    signal?.removeEventListener("abort", abort)

    const escapedModel = JSON.stringify(providerModel).slice(1, -1)
    const initial = replace(chunks, found.start, found.end, escapedModel)
    chunks.length = 0
    return finalizeRoot(passthrough(initial, reader, done, signal), includeUsage)
  }

  return {
    model: found.model,
    cancel: (reason?: unknown) => {
      signal?.removeEventListener("abort", abort)
      return reader.cancel(reason)
    },
    stream,
    json: () => new Response(stream(found.model, false)).json(),
  }
}

function replace(chunks: Uint8Array[], start: number, end: number, value: string) {
  let offset = 0
  let inserted = false
  return chunks.flatMap((chunk) => {
    const chunkStart = offset
    const chunkEnd = offset + chunk.length
    offset = chunkEnd
    if (chunkEnd <= start || chunkStart >= end) return [chunk]

    const parts = [chunk.subarray(0, Math.max(0, start - chunkStart))]
    if (!inserted) {
      parts.push(encoder.encode(value))
      inserted = true
    }
    parts.push(chunk.subarray(Math.min(chunk.length, end - chunkStart)))
    return parts.filter((part) => part.length)
  })
}

function passthrough(
  initial: Array<Uint8Array | undefined>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sourceDone: boolean,
  signal?: AbortSignal,
) {
  let done = sourceDone
  let index = 0
  const abort = () => void reader.cancel(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const cleanup = () => signal?.removeEventListener("abort", abort)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        cleanup()
        controller.error(signal.reason ?? new DOMException("Aborted", "AbortError"))
        return
      }
      const chunk = initial[index]
      if (chunk) {
        initial[index++] = undefined
        controller.enqueue(chunk)
        return
      }
      initial.length = 0
      if (done) {
        cleanup()
        controller.close()
        return
      }
      const next = await reader.read()
      if (signal?.aborted) {
        cleanup()
        controller.error(signal.reason ?? new DOMException("Aborted", "AbortError"))
        return
      }
      done = next.done
      if (next.value && next.value.length > MAX_INPUT_CHUNK_BYTES) {
        cleanup()
        await reader.cancel("Request body chunk exceeds streaming limit").catch(() => {})
        controller.error(new Error("Request body chunk exceeds streaming limit"))
        return
      }
      if (next.value) controller.enqueue(next.value)
      if (done) {
        cleanup()
        controller.close()
      }
    },
    cancel(reason) {
      initial.length = 0
      cleanup()
      return reader.cancel(reason)
    },
  })
}

function finalizeRoot(body: ReadableStream<Uint8Array>, includeUsage: boolean) {
  const reader = body.getReader()
  const scanner = new RootJsonScanner()
  let injected = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        if (!injected) {
          controller.error(new Error("Invalid JSON request body"))
          return
        }
        controller.close()
        return
      }

      const chunk = next.value
      const close = scanner.push(chunk)
      if (close === undefined || injected) {
        controller.enqueue(chunk)
        return
      }

      if (close) controller.enqueue(chunk.subarray(0, close))
      if (scanner.modelKeyCount !== 1 || scanner.modelCount !== 1) {
        controller.error(new Error("Request body must contain exactly one root model field"))
        return
      }
      const fields: string[] = []
      if (includeUsage && scanner.stream) fields.push('"stream_options":{"include_usage":true}')
      if (fields.length) controller.enqueue(encoder.encode(`,${fields.join(",")}`))
      controller.enqueue(chunk.subarray(close))
      injected = true
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

type RootState = "key" | "colon" | "value" | "next"
type StringRole = "key" | "model" | "root-value" | "other"

class RootJsonScanner {
  offset = 0
  model: { model: string; start: number; end: number } | undefined
  modelKeyCount = 0
  modelCount = 0
  stream = false
  private depth = 0
  private state: RootState = "value"
  private key = ""
  private inString = false
  private escaped = false
  private role: StringRole = "other"
  private stringStart = 0
  private stringBytes: number[] = []
  private stringOverflow = false

  push(chunk: Uint8Array) {
    let rootClose: number | undefined
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]
      const absolute = this.offset + index
      if (this.inString) {
        if (this.escaped) {
          this.capture(byte)
          this.escaped = false
          continue
        }
        if (byte === 92) {
          this.capture(byte)
          this.escaped = true
          continue
        }
        if (byte !== 34) {
          this.capture(byte)
          continue
        }
        this.finishString(absolute)
        continue
      }

      if (byte === 34) {
        this.startString(absolute)
        continue
      }
      if (byte === 123 || byte === 91) {
        this.depth++
        if (this.depth === 1) this.state = "key"
        continue
      }
      if (byte === 125 || byte === 93) {
        if (this.depth === 1 && byte === 125) rootClose = index
        this.depth--
        if (this.depth === 1) this.state = "next"
        continue
      }
      if (this.depth !== 1) continue
      if (byte === 58 && this.state === "colon") {
        this.state = "value"
        continue
      }
      if (byte === 44) {
        this.key = ""
        this.state = "key"
        continue
      }
      if (this.state === "value" && this.key === "stream") {
        if (byte === 116) this.stream = true
        if (byte === 102) this.stream = false
      }
    }
    this.offset += chunk.length
    return rootClose
  }

  private startString(absolute: number) {
    this.inString = true
    this.escaped = false
    this.stringBytes = []
    this.stringOverflow = false
    this.stringStart = absolute + 1
    this.role =
      this.depth === 1 && this.state === "key"
        ? "key"
        : this.depth === 1 && this.state === "value" && this.key === "model"
          ? "model"
          : this.depth === 1 && this.state === "value"
            ? "root-value"
            : "other"
  }

  private capture(byte: number) {
    const limit = this.role === "key" ? 64 : 1024
    if (this.role !== "key" && this.role !== "model") return
    if (this.stringBytes.length >= limit) {
      this.stringOverflow = true
      return
    }
    this.stringBytes.push(byte)
  }

  private finishString(absolute: number) {
    this.inString = false
    if (this.stringOverflow) {
      if (this.role === "key") {
        this.key = ""
        this.state = "colon"
        return
      }
      if (this.role === "model") throw new Error("Model field exceeds value limit")
    }
    const value = () => JSON.parse(`"${new TextDecoder().decode(new Uint8Array(this.stringBytes))}"`) as string
    if (this.role === "key") {
      this.key = value()
      if (this.key === "model") this.modelKeyCount++
      this.state = "colon"
      return
    }
    if (this.role === "model" && !this.model) {
      this.model = { model: value(), start: this.stringStart, end: absolute }
    }
    if (this.role === "model") this.modelCount++
    if (this.role === "model" || this.role === "root-value") this.state = "next"
  }
}
