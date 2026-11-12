import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import {
  readControlFrames,
  spawnExecutionProcess,
  type ExecutionTransport,
  type RootExit,
} from "../../src/extension/execution-process"
import { superviseExecution } from "../../src/extension/execution-supervisor"
import type { ExecutionCommand, ExecutionEvent } from "../../src/extension/execution-protocol"
import { executionIdentity } from "./execution-fixture"

function control(autoExit: boolean) {
  const { identity } = executionIdentity()
  let receive: (input: unknown) => void = () => {}
  let fail: (error: Error) => void = () => {}
  let finish!: (outcome: RootExit) => void
  const exited = new Promise<RootExit>((resolve) => {
    finish = resolve
  })
  const commands: ExecutionCommand[] = []
  let terminated = 0
  let released = false
  const event = (type: "hello" | "ready" | "drained" | "disposed") => receive({ version: 1, identity, type })
  const transport: ExecutionTransport = {
    exited,
    subscribe(message, failure) {
      receive = message
      fail = failure
      return () => {
        receive = () => {}
      }
    },
    send(command) {
      commands.push(command)
      if (command.type === "drain") queueMicrotask(() => event("drained"))
      if (command.type === "dispose") queueMicrotask(() => event("disposed"))
    },
    terminate() {
      terminated++
      if (autoExit) finish({ code: null, signal: "SIGKILL" })
    },
    async release() {
      released = true
    },
  }
  const logs: string[] = []
  const supervisor = superviseExecution({
    identity,
    transport,
    limits: { readinessMs: 1000, drainMs: 1000, disposeMs: 1000, exitMs: 10, maxPending: 1 },
    report: (event) => logs.push(event),
  })
  return {
    identity,
    transport,
    supervisor,
    event,
    emit: (event: unknown) => receive(event),
    fail: (error: Error) => fail(error),
    commands,
    logs,
    finish,
    exited,
    terminated: () => terminated,
    released: () => released,
  }
}

test("foreign-fenced replies cannot resolve a registered request", async () => {
  const c = control(true)
  await using supervisor = c.supervisor
  c.event("hello")
  c.event("ready")
  await supervisor.ready()
  let applied = false
  const request = supervisor.request("echo", null).then((value) => {
    applied = true
    return value
  })
  const command = c.commands.find((entry) => entry.type === "request")
  if (!command || command.type !== "request") throw new Error("Missing request")
  const reply: ExecutionEvent = {
    version: 1,
    identity: c.identity,
    type: "result",
    requestId: command.requestId,
    value: "accepted",
  }
  for (const field of ["storeId", "installationId", "generationId", "runtimeId", "epoch"] as const) {
    c.emit({ ...reply, identity: { ...c.identity, [field]: field === "epoch" ? 1 : randomUUID() } })
    await Promise.resolve()
    expect(applied).toBe(false)
  }
  c.emit(reply)
  expect(await request).toBe("accepted")
  expect(c.logs.filter((line) => line.includes("discarded-foreign-fence"))).toHaveLength(5)
})

test("a late reply after stop cannot replace the request's closed outcome", async () => {
  const c = control(true)
  await using supervisor = c.supervisor
  c.event("hello")
  c.event("ready")
  await supervisor.ready()
  const result = supervisor.request("echo", null).then(
    () => "applied",
    (error: unknown) => (error instanceof Error ? error.message : "unexpected"),
  )
  const command = c.commands.find((entry) => entry.type === "request")
  if (!command || command.type !== "request") throw new Error("Missing request")
  const stopping = supervisor.stop()
  c.emit({ version: 1, identity: c.identity, type: "result", requestId: command.requestId, value: "late" })
  expect(await result).toContain("closed")
  expect(c.logs.some((line) => line.includes("discarded-late-result"))).toBe(true)
  await stopping
})

test("pending capacity rejects before a second command is sent", async () => {
  const c = control(true)
  await using supervisor = c.supervisor
  c.event("hello")
  c.event("ready")
  await supervisor.ready()
  const first = supervisor.request("hold", null).catch(() => "closed")
  await expect(supervisor.request("second", null)).rejects.toMatchObject({ code: "capacity" })
  expect(c.commands.filter((entry) => entry.type === "request")).toHaveLength(1)
  await supervisor.stop()
  expect(await first).toBe("closed")
})

test("deadline and kill attempt cannot manufacture OS exit; a later observation permits retry", async () => {
  const c = control(false)
  await using supervisor = c.supervisor
  c.event("hello")
  c.event("ready")
  await supervisor.ready()
  expect(await supervisor.stop()).toMatchObject({ status: "unknown", tree: "unproven" })
  expect(c.terminated()).toBe(1)
  expect(c.released()).toBe(false)
  c.finish({ code: 9, signal: null })
  await c.exited
  expect(await supervisor.stop()).toMatchObject({ status: "rootExited", exit: { code: 9 }, tree: "unproven" })
  expect(c.released()).toBe(true)
})

for (const invalid of ["ready-before-hello", "duplicate-hello", "wrong-version", "unsolicited-dispose"])
  test(`${invalid} closes admission and invokes external termination`, async () => {
    const c = control(true)
    await using supervisor = c.supervisor
    if (invalid === "ready-before-hello") c.event("ready")
    if (invalid === "duplicate-hello") {
      c.event("hello")
      c.event("hello")
    }
    if (invalid === "wrong-version") c.emit({ version: 2, identity: c.identity, type: "hello" })
    if (invalid === "unsolicited-dispose") c.event("disposed")
    await expect(supervisor.ready()).rejects.toMatchObject({ code: "protocol" })
    expect(c.terminated()).toBeGreaterThan(0)
    expect((await supervisor.stop()).status).toBe("rootExited")
  })

test("transport release failure remains structured and causes scoped disposal to fail", async () => {
  const c = control(true)
  const original = new Error("Controlled stream close failure")
  c.transport.release = async () => {
    throw original
  }
  c.event("hello")
  c.event("ready")
  await c.supervisor.ready()
  const result = await c.supervisor.stop()
  expect(result.issues).toContain("releaseFailed")
  expect(result.failure?.cause).toBe(original)
  await expect(c.supervisor[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "transport" })
})

for (const stage of ["drain", "dispose", "exit"] as const)
  for (const kind of ["transport", "protocol"] as const)
    test(`fatal ${kind} during ${stage} survives stop bookkeeping`, async () => {
      const c = control(true)
      c.event("hello")
      c.event("ready")
      await c.supervisor.ready()
      const original = new Error("Controlled transport failure")
      const inject = () => {
        if (kind === "transport") c.fail(original)
        else c.emit({ version: 2, identity: c.identity, type: "hello" })
      }
      c.transport.send = (command) => {
        c.commands.push(command)
        if (command.type === stage) return inject()
        if (command.type === "drain") queueMicrotask(() => c.event("drained"))
        if (command.type === "dispose")
          queueMicrotask(() => {
            c.event("disposed")
            if (stage === "exit") queueMicrotask(inject)
          })
      }
      const result = await c.supervisor.stop()
      expect(result.status).toBe("rootExited")
      expect(result.tree).toBe("unproven")
      expect(result.issues).toContain(kind)
      expect(result.failure?.code).toBe(kind)
      if (kind === "transport") expect(result.failure?.cause).toBe(original)
      expect(result.issues).not.toContain("drainDeadline")
      expect(result.issues).not.toContain("disposeDeadline")
      expect(c.released()).toBe(true)
    })

for (const stage of ["before-stop", "drain", "dispose"] as const)
  test(`root exit before ${stage} acknowledgement remains an exited issue, not a deadline`, async () => {
    const c = control(true)
    c.event("hello")
    c.event("ready")
    await c.supervisor.ready()
    c.transport.send = (command) => {
      c.commands.push(command)
      if (command.type === stage) c.finish({ code: 0, signal: null })
      else if (command.type === "drain") queueMicrotask(() => c.event("drained"))
    }
    if (stage === "before-stop") {
      c.finish({ code: 0, signal: null })
      await c.exited
    }
    const result = await c.supervisor.stop()
    expect(result).toMatchObject({ status: "rootExited", exit: { code: 0 }, tree: "unproven" })
    expect(result.issues).toEqual(["exited"])
    expect(result.failure?.code).toBe("exited")
  })

test("acknowledged dispose followed by successful OS exit stays issue-free", async () => {
  const c = control(true)
  c.event("hello")
  c.event("ready")
  await c.supervisor.ready()
  c.transport.send = (command) => {
    if (command.type === "drain") queueMicrotask(() => c.event("drained"))
    if (command.type === "dispose")
      queueMicrotask(() => {
        c.event("disposed")
        c.finish({ code: 0, signal: null })
      })
  }
  expect(await c.supervisor.stop()).toEqual({
    status: "rootExited",
    exit: { code: 0, signal: null },
    tree: "unproven",
    issues: [],
  })
})

test("control framing preserves split UTF-8 frames and multiple messages per chunk", async () => {
  const stream = new PassThrough()
  const messages: unknown[] = []
  const errors: Error[] = []
  const remove = readControlFrames(
    stream,
    128,
    (value) => messages.push(value),
    (error) => errors.push(error),
  )
  try {
    const bytes = Buffer.from('{"text":"中文"}\n{"next":true}\n')
    stream.write(bytes.subarray(0, 11))
    stream.write(bytes.subarray(11))
    expect(messages).toEqual([{ text: "中文" }, { next: true }])
    expect(errors).toEqual([])
  } finally {
    remove()
    const closed = new Promise<void>((resolve) => stream.once("close", resolve))
    stream.destroy()
    await closed
  }
})

for (const [name, input] of [
  ["oversized", '"' + "x".repeat(17)],
  ["malformed", "no-json\n{}\n"],
  ["truncated", '{"unfinished":'],
  ["invalid-utf8", Buffer.from([0x22, 0xff, 0x22, 10])],
] as const)
  test(`control framing fails once for ${name} input`, async () => {
    const stream = new PassThrough()
    const messages: unknown[] = []
    const errors: Error[] = []
    const remove = readControlFrames(
      stream,
      16,
      (value) => messages.push(value),
      (error) => errors.push(error),
    )
    try {
      const ended = new Promise<void>((resolve) => stream.once("end", resolve))
      stream.end(input)
      await ended
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: "protocol" })
      expect(messages).toEqual([])
    } finally {
      remove()
      if (!stream.closed) {
        const closed = new Promise<void>((resolve) => stream.once("close", resolve))
        stream.destroy()
        await closed
      }
    }
  })

test("transport queue budget overflow rejects before spawning", async () => {
  await expect(
    spawnExecutionProcess({
      executable: process.execPath,
      args: [],
      frameBytes: Number.MAX_SAFE_INTEGER,
      bufferedFrames: 2,
      exitMs: 1000,
      log() {},
    }),
  ).rejects.toBeInstanceOf(RangeError)
})

test("missing executable rejects transport construction without an unobserved process handle", async () => {
  await expect(
    spawnExecutionProcess({
      executable: `/nonexistent-execution-${randomUUID()}`,
      args: [],
      frameBytes: 1024,
      bufferedFrames: 4,
      exitMs: 1000,
      log() {},
    }),
  ).rejects.toMatchObject({ code: "transport" })
})
