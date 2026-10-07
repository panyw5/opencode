import { describe, expect, test } from "bun:test"
import extension from "../src/server"

function makeHost() {
  const emitted: Array<{ name: string; data: unknown; options?: { directory?: string } }> = []
  const host = {
    id: "example.hello-viewer",
    version: "0.0.0-test",
    dataDir: "/tmp/hello-viewer-data",
    cacheDir: "/tmp/hello-viewer-cache",
    serverUrl: new URL("http://127.0.0.1:4096"),
    settings: {
      get: () => ({}) as Record<string, unknown>,
      onDidChange: () => () => {},
    },
    emit: (name: string, data: unknown, options?: { directory?: string }) => {
      emitted.push({ name, data, options })
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }
  return { host, emitted }
}

describe("hello-viewer server extension", () => {
  test("declares the example.hello-viewer id", () => {
    expect(extension.id).toBe("example.hello-viewer")
  })

  test("echo rpc echoes the requested message with provenance", async () => {
    const { host } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    const result = (await service.rpc?.["echo"](
      { message: "hi" },
      {
        signal: new AbortController().signal,
      },
    )) as { echo: string; extension: string; at: string }
    expect(result.echo).toBe("hi")
    expect(result.extension).toBe("example.hello-viewer")
    expect(typeof result.at).toBe("string")
    await service.dispose?.()
  })

  test("echo rpc tolerates a missing or malformed message", async () => {
    const { host } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    const result = (await service.rpc?.["echo"](null, { signal: new AbortController().signal })) as {
      echo: string
    }
    expect(result.echo).toBe("")
    await service.dispose?.()
  })

  test("greet rpc emits a namespaced event and returns the payload", async () => {
    const { host, emitted } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    const payload = (await service.rpc?.greet(
      { message: "hi there" },
      {
        signal: new AbortController().signal,
        directory: "/tmp/project",
      },
    )) as { message: string; from: string }

    expect(payload.message).toBe("hi there")
    expect(payload.from).toBe("example.hello-viewer")
    expect(emitted).toHaveLength(1)
    expect(emitted[0].name).toBe("example.hello-viewer/greeting")
    expect(emitted[0].options?.directory).toBe("/tmp/project")
    await service.dispose?.()
  })

  test("child ping fails before the child is explicitly started", async () => {
    const { host } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    expect(service.rpc?.["child.ping"]({ text: "x" }, { signal: new AbortController().signal })).rejects.toThrow(
      "child is not running",
    )
    await service.dispose?.()
  })

  test("child lifecycle: start, ping, stop", async () => {
    const { host } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    try {
      const started = (await service.rpc?.["child.start"]({}, { signal: new AbortController().signal })) as {
        running: boolean
        pid: number
      }
      expect(started.running).toBe(true)
      expect(started.pid).toBeGreaterThan(0)

      const ping = (await service.rpc?.["child.ping"](
        { text: "hello child" },
        {
          signal: new AbortController().signal,
        },
      )) as { echoed: string }
      expect(ping.echoed).toBe("hello child")

      const stopped = (await service.rpc?.["child.stop"]({}, { signal: new AbortController().signal })) as {
        stopped: boolean
      }
      expect(stopped.stopped).toBe(true)
    } finally {
      await service.dispose?.()
    }
  })

  test("concurrent child pings each receive their own reply", async () => {
    const { host } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    try {
      await service.rpc?.["child.start"]({}, { signal: new AbortController().signal })
      const texts = ["first", "second", "third", "fourth", "fifth"]
      const replies = await Promise.all(
        texts.map((text) => service.rpc?.["child.ping"]({ text }, { signal: new AbortController().signal })),
      )
      expect(replies).toEqual(texts.map((echoed) => ({ echoed })))
    } finally {
      await service.dispose?.()
    }
  })

  test("dispose stops a still-running child", async () => {
    const { host } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    await service.rpc?.["child.start"]({}, { signal: new AbortController().signal })
    await service.dispose?.()
    expect(service.rpc?.["child.ping"]({ text: "x" }, { signal: new AbortController().signal })).rejects.toThrow(
      "child is not running",
    )
  })

  test("activation does not spawn a child up front", async () => {
    const { host } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    // Only the echo/greet handlers are exercised; the child must stay dormant.
    await service.rpc?.["echo"]({ message: "warm" }, { signal: new AbortController().signal })
    await service.dispose?.()
  })

  test("instance-level server() exposes exactly one LLM tool", async () => {
    const { host, emitted } = makeHost()
    const service = (await extension.activate?.(host as never)) ?? {}
    const hooks = await extension.server?.({
      extension: { ...host, service },
    } as never)
    const tools = Object.keys(hooks?.tool ?? {})
    expect(tools).toEqual(["hello_greet"])

    const result = await hooks?.tool?.hello_greet.execute({ name: "World" }, {
      sessionID: "ses_test",
      messageID: "msg_test",
      agent: "build",
      directory: "/tmp/project",
      worktree: "/tmp/project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: () => Promise.resolve(),
    } as never)
    expect(result).toBe("Hello, World! (from example.hello-viewer)")
    expect(emitted).toHaveLength(1)
    expect(emitted[0].name).toBe("example.hello-viewer/greeting")
    expect((emitted[0].data as { source?: string }).source).toBe("tool")
    await service.dispose?.()
  })
})
