import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Schema } from "effect"
import { HostProcessError, type RuntimeIdentity } from "../../../src/extension/host-process/protocol.ts"
import { spawnWorkerTransport } from "../../../src/extension/host-process/transport.ts"
import { superviseWorker, type SupervisedWorker } from "../../../src/extension/host-process/supervisor.ts"
import { outcome, testIdentity, testLimits, trace } from "./fixture.ts"

/**
 * T5.2 end-to-end: real worker processes (Bun and Node) loading a real
 * extension server entry through the fd control protocol. The test-side host
 * implements the §3.3 spawn data plane so the worker's host.* proxies run
 * against the actual wire contract.
 */

const fixtureDir = fileURLToPath(new URL("./fixtures", import.meta.url))
const workerFixture = fileURLToPath(new URL("./fixtures/worker-extension.mjs", import.meta.url))
const extServer = fileURLToPath(new URL("./fixtures/ext-server.mjs", import.meta.url))
const extServerBad = fileURLToPath(new URL("./fixtures/ext-server-bad.mjs", import.meta.url))
const cliIndex = fileURLToPath(new URL("../../../src/index.ts", import.meta.url))

function initPayload(over: Record<string, unknown> = {}) {
  return {
    id: "test.fixture-ext",
    version: "1.0.0",
    dir: fixtureDir,
    entry: extServer,
    dataDir: fixtureDir,
    cacheDir: fixtureDir,
    serverUrl: "http://127.0.0.1:4096",
    settings: { alpha: 1, nested: { deep: true } },
    ...over,
  }
}

/** Per-process credit budget; mirrors design §2.3 (256 KiB per spawned child). */
const PROC_CREDIT = 256 * 1024

/** Poll a published signal instead of racing the scheduler with a sleep. */
async function waitUntil(check: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

type Proc = {
  child: ChildProcess
  seqOut: number
  seqErr: number
  credit: number
  exitSent: boolean
}

/**
 * Host-side implementation of the reverse channel: spawn requests run real
 * children whose stdio/exit flow back as proc.* notifies — exactly the
 * contract T5.3 will implement against the runtime.
 */
class FixtureHost {
  supervisor!: SupervisedWorker
  notifications: [string, unknown][] = []
  calls: [string, unknown][] = []
  asks: unknown[] = []
  denyAsk = false
  procs = new Map<string, Proc>()

  last(method: string) {
    return this.notifications.filter(([name]) => name === method).at(-1)?.[1]
  }
  all(method: string) {
    return this.notifications.filter(([name]) => name === method).map(([, value]) => value)
  }
  procIds() {
    const ids = new Set<string>()
    for (const [, value] of this.notifications) {
      const id = (value as { processId?: unknown })?.processId
      if (typeof id === "string") ids.add(id)
    }
    for (const [, value] of this.calls) {
      const id = (value as { processId?: unknown })?.processId
      if (typeof id === "string") ids.add(id)
    }
    return ids
  }

  onNotify = (method: string, value: Schema.Json) => {
    this.notifications.push([method, value])
    const input = (value ?? {}) as Record<string, unknown>
    if (method === "proc.stdin") {
      const proc = this.procs.get(input.processId as string)
      proc?.child.stdin?.write(Buffer.from(input.data as string, "base64"))
    }
    if (method === "proc.credit") {
      const proc = this.procs.get(input.processId as string)
      if (proc) {
        proc.credit += input.bytes as number
        if (proc.credit > 0) {
          proc.child.stdout?.resume()
          proc.child.stderr?.resume()
        }
      }
    }
  }

  onHostCall = async (method: string, value: Schema.Json): Promise<Schema.Json> => {
    this.calls.push([method, value])
    const input = (value ?? {}) as Record<string, unknown>
    switch (method) {
      case "host.spawn":
        return this.spawn(input)
      case "proc.kill": {
        const proc = this.procs.get(input.processId as string)
        proc?.child.kill(input.signal === "KILL" ? "SIGKILL" : "SIGTERM")
        return null
      }
      case "proc.stdin-end": {
        this.procs.get(input.processId as string)?.child.stdin?.end()
        return null
      }
      case "tool.ask": {
        this.asks.push(value)
        if (this.denyAsk) throw new HostProcessError({ code: "denied", detail: "ask denied by harness" })
        return null
      }
    }
    throw new Error(`unknown host.call ${method}`)
  }

  private spawn(input: Record<string, unknown>): Schema.Json {
    // "inherit" is documented as merged into the host log stream (Q9); the
    // harness maps it to ignore since it has no log stream of its own.
    const stdio = (input.stdio as string[]).map((mode) => (mode === "pipe" ? ("pipe" as const) : ("ignore" as const)))
    const child = spawn(input.command as string, input.args as string[], {
      env: { ...process.env, ...((input.env as Record<string, string>) ?? {}) },
      cwd: (input.cwd as string) ?? undefined,
      stdio: [stdio[0], stdio[1], stdio[2]],
    })
    const processId = randomUUID()
    const proc: Proc = { child, seqOut: 0, seqErr: 0, credit: PROC_CREDIT, exitSent: false }
    this.procs.set(processId, proc)
    const forward = (stream: NodeJS.ReadableStream | null, name: string, seq: "seqOut" | "seqErr") => {
      if (!stream) return
      const rs = stream as NodeJS.ReadableStream & { pause(): void; resume(): void }
      // Design §3.3 caps a proc.* data frame at 64 KiB — and Bun's child
      // stdout can deliver the entire accumulated output as one giant 'data'
      // chunk, so slicing here is required, not just polite.
      rs.on("data", (chunk: Buffer) => {
        // Frame credit is the pacing mechanism — the host must stop reading
        // once the worker's budget is spent (design §3.3). With 1 MiB frames
        // and this test's volume the transport's capacity guard cannot fire.
        if (proc.credit <= 0) rs.pause()
        for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
          const piece = chunk.subarray(offset, offset + 64 * 1024)
          proc.credit -= piece.length
          this.supervisor.notify(name, { processId, seq: proc[seq]++, data: piece.toString("base64") })
        }
      })
    }
    forward(child.stdout, "proc.stdout", "seqOut")
    forward(child.stderr, "proc.stderr", "seqErr")
    const sendExit = (code: number | null, signal: string | null) => {
      if (proc.exitSent) return
      proc.exitSent = true
      this.supervisor.notify("proc.exit", { processId, code, signal })
    }
    child.once("error", (cause) => {
      this.supervisor.notify("proc.error", { processId, message: String(cause.message) })
      sendExit(null, null)
    })
    child.once("exit", (code, signal) => sendExit(code, signal))
    return { processId, pid: child.pid ?? null } as Schema.Json
  }
}

for (const [runtime, executable] of [
  ["bun", Bun.which("bun")],
  ["node", Bun.which("node")],
] as const) {
  // Bun extra-fd adaptation is verified on Darwin only (Q8); the Node path is
  // kept under the same gate so both run the same coverage matrix.
  const run = test.skipIf(!executable || process.platform === "win32")
  const launch = (identity: RuntimeIdentity, events: ReturnType<typeof trace>) =>
    spawnWorkerTransport({
      executable: executable!,
      args: [workerFixture, JSON.stringify(identity)],
      // 1 MiB frames (design default): a max-size 64 KiB stdio chunk becomes a
      // ~88 KiB base64 frame, which would exceed a smaller budget and get
      // dropped by the transport's capacity guard.
      frameBytes: 1024 * 1024,
      bufferedFrames: 16,
      exitMs: 10_000,
      log: (stream, text) => events.report(`${stream}: ${text}`),
    })

  const start = async (init: Record<string, unknown>, events: ReturnType<typeof trace>) => {
    const identity = testIdentity()
    const transport = await launch(identity, events)
    const host = new FixtureHost()
    const supervisor = superviseWorker({
      extension: "test.fixture-ext",
      identity,
      transport,
      limits: testLimits(),
      hooks: {
        report: events.report,
        init: init as Schema.Json,
        onNotify: (method, value) => host.onNotify(method, value),
        onHostCall: (method, value) => host.onHostCall(method, value),
      },
    })
    host.supervisor = supervisor
    return { identity, transport, supervisor, host }
  }

  run(`${runtime}: service.rpc covers echo, not-found, domain-error envelope, and abort`, async () => {
    const events = trace()
    const { transport, supervisor } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready().catch((cause) => {
      throw new Error(events.text(), { cause })
    })
    expect(await supervisor.request("service.rpc", { method: "echo", input: { hi: 1 } })).toEqual({
      status: "ok",
      value: { hi: 1 },
    })
    expect(await supervisor.request("service.rpc", { method: "missing", input: null })).toEqual({
      status: "notFound",
    })
    expect(await supervisor.request("service.rpc", { method: "rpc.error", input: null })).toEqual({
      status: "error",
      code: "domain_code",
      message: "fixture domain failure",
    })
    const abort = new AbortController()
    const held = outcome(supervisor.request("service.rpc", { method: "hold", input: null }, abort.signal))
    await events.wait("fixture-hold-entered")
    abort.abort()
    expect(await held).toMatchObject({ status: "rejected", code: "cancelled" })
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: init snapshot, emit, host.log, settings push, and timers cross the wire`, async () => {
    const events = trace()
    const { transport, supervisor, host } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()
    expect(await supervisor.request("service.rpc", { method: "settings.get", input: null })).toEqual({
      status: "ok",
      value: { alpha: 1, nested: { deep: true } },
    })
    // emit + log notify frames (frames on one pipe are ordered before result).
    expect(await supervisor.request("service.rpc", { method: "emit", input: { data: { n: 1 } } })).toEqual({
      status: "ok",
      value: "emitted",
    })
    expect(host.last("host.emit")).toEqual({ name: "fixture.event", data: { n: 1 }, directory: null })
    expect(
      await supervisor.request("service.rpc", { method: "log.write", input: { level: "warn", message: "hi" } }),
    ).toEqual({ status: "ok", value: "logged" })
    expect(host.last("host.log")).toEqual({ level: "warn", message: "hi", extra: null })
    // settings.changed: cache updates before the extension's listener fires,
    // and the listener's own emit rides back over the channel.
    supervisor.notify("settings.changed", { values: { alpha: 2, beta: "new" } })
    await waitUntil(
      () => (host.last("host.emit") as { name?: string } | undefined)?.name === "fixture.settings.seen",
      "settings.seen emit",
    )
    expect(host.last("host.emit")).toEqual({
      name: "fixture.settings.seen",
      data: { next: { alpha: 2, beta: "new" } },
      directory: null,
    })
    expect(await supervisor.request("service.rpc", { method: "settings.get", input: null })).toEqual({
      status: "ok",
      value: { alpha: 2, beta: "new" },
    })
    // host.setTimeout is worker-local but its emit still crosses the wire.
    expect(await supervisor.request("service.rpc", { method: "timer", input: { delay: 5 } })).toEqual({
      status: "ok",
      value: "scheduled",
    })
    await waitUntil(
      () => (host.last("host.emit") as { name?: string } | undefined)?.name === "fixture.timer",
      "timer emit",
    )
    expect(host.last("host.emit")).toEqual({ name: "fixture.timer", data: { after: 5 }, directory: null })
    // A throwing timer callback reports runtime.error + host.log notifies.
    await supervisor.request("service.rpc", { method: "timer.throw", input: null })
    await waitUntil(() => host.last("runtime.error") !== undefined, "runtime.error notify")
    expect(host.last("runtime.error")).toMatchObject({ phase: "timer", message: "fixture timer boom" })
    expect(events.text()).toContain("timer-failed fixture timer boom")
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: instance.start returns tool descriptors and instance rpc/event/dispose work`, async () => {
    const events = trace()
    const { transport, supervisor, host } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()
    const directory = "/tmp/fixture-instance"
    const started = (await supervisor.request("instance.start", {
      directory,
      worktree: "/tmp/fixture-worktree",
      project: { id: "p1" },
    })) as {
      tools: { name: string; description: string; parameters: Record<string, unknown> }[]
      rpc: string[]
      event: boolean
    }
    expect(started.tools).toHaveLength(1)
    expect(started.tools[0]!.name).toBe("greet")
    expect(started.tools[0]!.description).toBe("fixture greet")
    expect(started.tools[0]!.parameters).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    })
    expect(started.rpc).toEqual(
      expect.arrayContaining([
        "instance.echo",
        "input.probe",
        "input.client",
        "input.dollar",
        "input.workspace",
        "service.direct",
      ]),
    )
    expect(started.event).toBe(true)

    expect(await supervisor.request("instance.rpc", { directory, method: "instance.echo", input: { v: 2 } })).toEqual({
      status: "ok",
      value: { value: { v: 2 }, directory },
    })
    // The instance input carries serializable PluginInput fields plus the
    // in-worker input.extension.service object.
    expect(await supervisor.request("instance.rpc", { directory, method: "input.probe", input: null })).toEqual({
      status: "ok",
      value: {
        directory,
        worktree: "/tmp/fixture-worktree",
        serverUrl: "http://127.0.0.1:4096/",
        hasService: true,
        ctxDirectory: directory,
      },
    })
    expect(
      await supervisor.request("instance.rpc", { directory, method: "service.direct", input: { deep: 1 } }),
    ).toEqual({ status: "ok", value: { deep: 1 } })
    // instance.event notify reaches hooks.event; the fixture emits it back.
    supervisor.notify("instance.event", { directory, event: { type: "fixture.tick" } })
    await waitUntil(
      () => (host.last("host.emit") as { name?: string } | undefined)?.name === "fixture.event.seen",
      "event.seen emit",
    )
    expect(host.last("host.emit")).toEqual({
      name: "fixture.event.seen",
      data: { event: { type: "fixture.tick" } },
      directory: null,
    })
    // instance.dispose runs hooks.dispose then the instance is gone.
    expect(await supervisor.request("instance.dispose", { directory })).toEqual({ disposed: true })
    await events.wait("fixture-instance-disposed")
    expect(await supervisor.request("instance.rpc", { directory, method: "instance.echo", input: null })).toEqual({
      status: "notFound",
    })
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: tool.execute proxies ctx fields, metadata notify, ask host.call, and abort`, async () => {
    const events = trace()
    const { transport, supervisor, host } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()
    const directory = "/tmp/fixture-tools"
    await supervisor.request("instance.start", { directory })
    const ctx = { sessionID: "s1", messageID: "m1", agent: "a1", directory, worktree: "/wt" }
    expect(
      await supervisor.request("tool.execute", {
        directory,
        tool: "greet",
        args: { name: "world" },
        call: "call-1",
        ctx,
      }),
    ).toEqual({
      title: "hi world",
      output: "hello world",
      metadata: { session: "s1", agent: "a1", dir: directory },
    })
    // tool.metadata rides a notify keyed by the host-minted correlation id.
    expect(host.last("tool.metadata")).toEqual({ call: "call-1", title: "greeted world", metadata: { who: "world" } })

    // ctx.ask is a reverse host.call; the granted answer completes the tool.
    expect(
      await supervisor.request("tool.execute", { directory, tool: "greet", args: { name: "ask" }, call: "call-2", ctx }),
    ).toMatchObject({ output: "hello ask" })
    expect(host.asks).toEqual([
      { call: "call-2", ask: { permission: "fixture", patterns: ["*"], always: ["*"], metadata: { q: 1 } } },
    ])

    // Host denial propagates as a denied rejection of the tool request.
    host.denyAsk = true
    expect(
      await outcome(
        supervisor.request("tool.execute", { directory, tool: "greet", args: { name: "ask" }, call: "call-3", ctx }),
      ),
    ).toMatchObject({ status: "rejected", code: "denied" })

    // ctx.abort is the request's cancel signal.
    const abort = new AbortController()
    const held = outcome(
      supervisor.request(
        "tool.execute",
        { directory, tool: "greet", args: { name: "hold" }, call: "call-4", ctx },
        abort.signal,
      ),
    )
    await events.wait("fixture-tool-hold-entered")
    abort.abort()
    expect(await held).toMatchObject({ status: "rejected", code: "cancelled" })
    // An unknown tool/missing instance produces structured request failures.
    expect(
      await outcome(supervisor.request("tool.execute", { directory, tool: "nope", args: {}, call: "c", ctx })),
    ).toMatchObject({ status: "rejected", code: "requestFailed" })
    expect(
      await outcome(supervisor.request("tool.execute", { directory: "/none", tool: "greet", args: {}, call: "c", ctx })),
    ).toMatchObject({ status: "rejected", code: "requestFailed" })
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: input.client/$/experimental_workspace stubs throw clear errors`, async () => {
    const events = trace()
    const { transport, supervisor } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()
    const directory = "/tmp/fixture-stubs"
    await supervisor.request("instance.start", { directory })
    const client = (await supervisor.request("instance.rpc", { directory, method: "input.client", input: null })) as {
      value: string
    }
    expect(client.value).toContain("input.client is not available")
    const dollar = (await supervisor.request("instance.rpc", { directory, method: "input.dollar", input: null })) as {
      value: string
    }
    expect(dollar.value).toContain("BunShell")
    const workspace = (await supervisor.request("instance.rpc", {
      directory,
      method: "input.workspace",
      input: null,
    })) as { value: string }
    expect(workspace.value).toContain("experimental_workspace.register is not supported")
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: host.spawn proxies stdin/stdout/exit/kill with proc.* frames`, async () => {
    const events = trace()
    const { transport, supervisor, host } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()

    // cat round-trip: stdin pipe writes reach the host child, stdout frames
    // reach the extension stream, proc.exit settles onExit.
    const echo = (await supervisor.request("service.rpc", {
      method: "spawn.echo",
      input: { text: "pipe-me" },
    })) as {
      status: string
      value: { output: string; exit: { code: number | null; signal: string | null }; pid: number }
    }
    expect(echo.value.output).toBe("pipe-me")
    expect(echo.value.exit).toEqual({ code: 0, signal: null })
    expect(echo.value.pid).toBeGreaterThan(0)
    const spawnCall = host.calls.find(([method]) => method === "host.spawn")
    expect(spawnCall?.[1]).toMatchObject({ command: "cat", args: [], stdio: ["pipe", "pipe", "ignore"] })
    // proc.stdin data + proc.stdin-end crossed the wire for that child.
    const stdinData = host.all("proc.stdin") as { processId: string; data: string }[]
    expect(stdinData.length).toBeGreaterThan(0)
    expect(Buffer.concat(stdinData.map((v) => Buffer.from(v.data, "base64"))).toString()).toBe("pipe-me")
    const echoProc = stdinData[0]!.processId
    expect(stdinData.every((v) => v.processId === echoProc)).toBe(true)
    expect(
      host.calls.filter(([m, v]) => m === "proc.stdin-end" && (v as { processId: string }).processId === echoProc),
    ).toHaveLength(1)
    // The worker returned credit for the consumed stdout bytes.
    const credited = host
      .all("proc.credit")
      .filter((v) => (v as { processId: string }).processId === echoProc)
      .reduce((sum, v) => sum + ((v as { bytes: number }).bytes ?? 0), 0)
    expect(credited).toBeGreaterThan(0)

    // ManagedProcess.kill routes through proc.kill and exit reports the signal.
    const killed = (await supervisor.request("service.rpc", { method: "spawn.kill", input: null })) as {
      value: { exit: { signal: string | null }; killed: boolean; exited: boolean }
    }
    expect(killed.value).toMatchObject({ exit: { signal: "SIGKILL" }, killed: true, exited: true })
    expect(host.calls.filter(([m]) => m === "proc.kill")).toHaveLength(1)

    // A failed spawn surfaces onError plus a terminal exit settlement.
    const failed = (await supervisor.request("service.rpc", { method: "spawn.fail", input: null })) as {
      value: { error: string; exited: boolean }
    }
    expect(failed.value.error).toContain("nonexistent-fixture-binary")
    expect(failed.value.exited).toBe(true)
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: proc.credit gates host reads beyond the initial budget`, async () => {
    const events = trace()
    const { transport, supervisor, host } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()
    // A bounded producer keeps the test deterministic under scheduler load:
    // even if a data frame were dropped, EOF still settles the extension's
    // onExit instead of hanging on an infinite stream.
    const source = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "oc-credit-")), "payload.bin")
    await fs.writeFile(source, Buffer.alloc(PROC_CREDIT * 2))
    const bytes = PROC_CREDIT + 64 * 1024
    const result = (await supervisor.request("service.rpc", {
      method: "spawn.many",
      input: { file: source, bytes },
    })) as { value: { received: number; exit: { code: number | null } } }
    expect(result.value.received).toBeGreaterThanOrEqual(bytes)
    // Without credit returns the host would have paused at 256 KiB.
    const credited = host.all("proc.credit").reduce((sum, v) => sum + ((v as { bytes: number }).bytes ?? 0), 0)
    expect(credited).toBeGreaterThanOrEqual(bytes - PROC_CREDIT)
    // The gate held: the host never sent more than budget + returned credit
    // + one in-flight chunk of overshoot.
    const sentBytes = host
      .all("proc.stdout")
      .reduce((sum, v) => sum + Buffer.from((v as { data: string }).data, "base64").length, 0)
    expect(sentBytes).toBeLessThanOrEqual(PROC_CREDIT + credited + 64 * 1024)
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: unsupported mutable-output hooks fail instance.start with a clear error`, async () => {
    const events = trace()
    const { transport, supervisor } = await start(initPayload({ entry: extServerBad }), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()
    expect(await outcome(supervisor.request("instance.start", { directory: "/tmp/bad" }))).toMatchObject({
      status: "rejected",
      code: "requestFailed",
    })
    expect((await supervisor.stop()).status).toBe("rootExited")
  }, 30_000)

  run(`${runtime}: dispose runs service.dispose and instance dispose before exiting cleanly`, async () => {
    const events = trace()
    const { transport, supervisor } = await start(initPayload(), events)
    await using _transport = transport
    await using _supervisor = supervisor
    await supervisor.ready()
    await supervisor.request("instance.start", { directory: "/tmp/fixture-dispose" })
    expect((await supervisor.stop()).status).toBe("rootExited")
    await events.wait("fixture-service-disposed")
    await events.wait("fixture-instance-disposed")
    expect(await transport.exited).toEqual({ code: 0, signal: null })
  }, 30_000)

  run(`${runtime}: activation failure reports readiness and never opens admission`, async () => {
    const events = trace()
    const { transport, supervisor } = await start(
      initPayload({ entry: fileURLToPath(new URL("./fixtures/missing-entry.mjs", import.meta.url)) }),
      events,
    )
    await using _transport = transport
    await using _supervisor = supervisor
    expect(await outcome(supervisor.ready())).toMatchObject({ status: "rejected", code: "readiness" })
    expect(await outcome(supervisor.request("service.rpc", { method: "echo", input: null }))).toMatchObject({
      code: "closed",
    })
    expect((await supervisor.stop()).status).toBe("rootExited")
    expect(events.text()).toContain("worker-failed phase=readiness")
  }, 30_000)
}

// The real CLI path exercises the argv interception before yargs. Bun only:
// `node src/index.ts` cannot resolve the `@/` tsconfig aliases used across
// the CLI module graph — a Node worker only ever loads host-process modules,
// which stay alias-free (the worker-extension.mjs matrix above).
const bun = Bun.which("bun")
const cli = test.skipIf(!bun || process.platform === "win32")

cli("cli: src/index.ts extension-host serves the real worker end-to-end", async () => {
  const identity = testIdentity()
  const events = trace()
  const transport = await spawnWorkerTransport({
    executable: bun!,
    args: [cliIndex, "extension-host", "--identity", JSON.stringify(identity)],
    frameBytes: 64 * 1024,
    bufferedFrames: 16,
    exitMs: 10_000,
    log: (stream, text) => events.report(`${stream}: ${text}`),
  })
  await using _transport = transport
  const supervisor = superviseWorker({
    extension: "test.fixture-ext",
    identity,
    transport,
    limits: testLimits({ readinessMs: 20_000 }),
    hooks: { report: events.report, init: initPayload() as Schema.Json },
  })
  await supervisor.ready().catch((cause) => {
    throw new Error(events.text(), { cause })
  })
  expect(await supervisor.request("service.rpc", { method: "echo", input: "via-cli" })).toEqual({
    status: "ok",
    value: "via-cli",
  })
  expect((await supervisor.stop()).status).toBe("rootExited")
}, 60_000)

cli("cli: extension-host without identity exits nonzero and --help prints usage", async () => {
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(bun!, [cliIndex, "extension-host", ...args], { stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      let err = ""
      child.stdout?.on("data", (c: Buffer) => (out += c))
      child.stderr?.on("data", (c: Buffer) => (err += c))
      child.once("exit", (code) => resolve({ code, out, err }))
    })
  const missing = await run([])
  expect(missing.code).toBe(1)
  expect(missing.err).toContain("--identity")
  const help = await run(["--help"])
  expect(help.code).toBe(0)
  expect(help.out).toContain("extension-host")
}, 60_000)
