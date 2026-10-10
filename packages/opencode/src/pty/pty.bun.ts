import { spawn as create } from "bun-pty"
import type { Exit, Opts, Proc } from "./pty"
import * as Log from "@opencode-ai/core/util/log"

export type { Disp, Exit, Opts, Proc } from "./pty"

const log = Log.create({ service: "pty.bun" })

type NativePty = ReturnType<typeof create>
type EarlyEvent = { type: "data"; value: string } | { type: "exit"; value: Exit }

const EARLY_OUTPUT_LIMIT = 2 * 1024 * 1024

export function adapt(pty: NativePty): Proc {
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: Exit) => void>()
  const pending: EarlyEvent[] = []
  let pendingBytes = 0
  let ready = false
  let flushScheduled = false

  function flush() {
    if (dataListeners.size === 0 && exitListeners.size === 0) return
    while (pending.length > 0) {
      const event = pending[0]
      if (!event) return
      pending.shift()
      if (event.type === "data") {
        pendingBytes -= event.value.length
        if (dataListeners.size === 0) continue
        for (const listener of dataListeners) listener(event.value)
      } else {
        if (exitListeners.size === 0) continue
        for (const listener of exitListeners) listener(event.value)
      }
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      ready = true
      flush()
    })
  }

  function enqueue(event: EarlyEvent) {
    const hasListener = event.type === "data" ? dataListeners.size > 0 : exitListeners.size > 0
    if (ready && pending.length === 0 && hasListener) {
      if (event.type === "data") {
        for (const listener of dataListeners) listener(event.value)
      } else {
        for (const listener of exitListeners) listener(event.value)
      }
      return
    }
    const wasEmpty = pending.length === 0
    const last = pending.at(-1)
    if (last?.type === "data" && event.type === "data") last.value += event.value
    else pending.push(event)
    if (event.type === "data") {
      pendingBytes += event.value.length
      while (pendingBytes > EARLY_OUTPUT_LIMIT) {
        const first = pending[0]
        if (!first || first.type !== "data") break
        const excess = pendingBytes - EARLY_OUTPUT_LIMIT
        const drop = Math.min(excess, first.value.length)
        pendingBytes -= drop
        log.warn("pty early output buffer truncated", {
          pid: pty.pid,
          bufferedCharacters: pendingBytes,
          droppedCharacters: drop,
        })
        if (drop === first.value.length) pending.shift()
        else pending[0] = { type: "data", value: first.value.slice(drop) }
      }
    }
    if (wasEmpty && (dataListeners.size > 0 || exitListeners.size > 0)) scheduleFlush()
  }

  // bun-pty may synchronously emit during spawn. Subscribe before returning
  // the adapter, then drain once the caller has had a chance to install hooks.
  pty.onData((data) => enqueue({ type: "data", value: data }))
  pty.onExit((event) => enqueue({ type: "exit", value: event }))
  scheduleFlush()

  return {
    pid: pty.pid,
    onData(listener) {
      dataListeners.add(listener)
      if (ready) scheduleFlush()
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit(listener) {
      exitListeners.add(listener)
      if (ready) scheduleFlush()
      return { dispose: () => exitListeners.delete(listener) }
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      pty.kill(signal)
    },
  }
}

export function spawn(file: string, args: string[], opts: Opts): Proc {
  return adapt(create(file, args, opts))
}
