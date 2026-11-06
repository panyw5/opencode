import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import type { KernelHandle, SpawnKernel } from "../../wls-repl/src/server"
import { NotebookKernels } from "../src/kernel"
import { host } from "./helpers"

test("kernel startup deduplication, busy/limit rejection, JSON-safe output and disposal", async () => {
  let spawned = 0
  const pending: Array<{ ctl: string; output(line: string): void }> = []
  const spawn: SpawnKernel = (options) => {
    spawned++
    const stdout = new Set<(line: string) => void>()
    const exit = new Set<(code: number | null) => void>()
    const handle: KernelHandle = {
      pid: undefined,
      onStdoutLine: (fn) => {
        stdout.add(fn)
        return () => stdout.delete(fn)
      },
      onStderrLine: () => () => {},
      onError: () => () => {},
      onExit: (fn) => {
        exit.add(fn)
        return () => exit.delete(fn)
      },
      kill: () => {
        for (const fn of exit) fn(null)
      },
    }
    const output = (line: string) => {
      for (const fn of stdout) fn(line)
    }
    pending.push({ ctl: options.ctlPath, output })
    setTimeout(() => output('\x1e12345678{"type":"ready"}'), 0)
    return handle
  }
  const kernels = new NotebookKernels(host({ maxKernels: 1 }), spawn)
  const signal = new AbortController().signal
  const evaluation = kernels.evaluate("/tmp/a.nb", "6 * 7", signal)
  const settled = evaluation.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  )
  try {
    await expect(kernels.evaluate("/tmp/a.nb", "other", signal)).rejects.toThrow("busy")
    while (!pending.length) await Bun.sleep(5)
    await expect(kernels.evaluate("/tmp/b.nb", "other", signal)).rejects.toThrow("Maximum")
    let request: { id: string } | undefined
    while (!request) {
      const text = await readFile(pending[0].ctl, "utf8")
      if (text.trim()) request = JSON.parse(text.trim())
      else await Bun.sleep(5)
    }
    pending[0].output("\x1ebad00000" + JSON.stringify({ type: "result", id: request.id, text: "wrong", ok: true }))
    pending[0].output(
      "\x1e12345678" + JSON.stringify({ type: "result", id: request.id, text: "42", printed: "", ok: true }),
    )
    const result = await settled
    expect(result).toEqual({ value: { ok: true, text: "42", printed: "" } })
    expect(spawned).toBe(1)
    await kernels.stop("/tmp/a.nb")
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(kernels.evaluate("/tmp/a.nb", "other", cancelled.signal)).rejects.toThrow("cancelled")
  } finally {
    await kernels.dispose()
  }
  await expect(kernels.evaluate("/tmp/a.nb", "other", signal)).rejects.toThrow("stopped")
})

test("spawn failures are actionable and leave no occupied kernel slot", async () => {
  const kernels = new NotebookKernels(host(), () => {
    throw new Error("spawn unavailable")
  })
  try {
    await expect(kernels.evaluate("/tmp/a.nb", "2+2", new AbortController().signal)).rejects.toThrow(
      "spawn unavailable",
    )
    await expect(kernels.evaluate("/tmp/a.nb", "2+2", new AbortController().signal)).rejects.toThrow(
      "spawn unavailable",
    )
  } finally {
    await kernels.dispose()
  }
})
