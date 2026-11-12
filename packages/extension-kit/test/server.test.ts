import { describe, expect, test } from "bun:test"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import {
  defineServerExtension,
  type ExtensionHooks,
  type ExtensionHost,
  type ExtensionService,
  type ServerExtension,
} from "../src/server"

describe("extension-kit server", () => {
  test("host timers expose explicit sync/async callback and disposable signatures", () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
    const timeoutCallback: Equal<Parameters<ExtensionHost["setTimeout"]>[0], () => void | Promise<void>> = true
    const intervalCallback: Equal<Parameters<ExtensionHost["setInterval"]>[0], () => void | Promise<void>> = true
    const timeoutDelay: Equal<Parameters<ExtensionHost["setTimeout"]>[1], number> = true
    const intervalDelay: Equal<Parameters<ExtensionHost["setInterval"]>[1], number> = true
    const timeoutHandle: Equal<ReturnType<ExtensionHost["setTimeout"]>, { dispose(): void }> = true
    const intervalHandle: Equal<ReturnType<ExtensionHost["setInterval"]>, { dispose(): void }> = true
    expect([timeoutCallback, intervalCallback, timeoutDelay, intervalDelay, timeoutHandle, intervalHandle]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
  })
  test("defineServerExtension returns the extension unchanged", () => {
    const extension: ServerExtension = { id: "acme.example" }
    expect(defineServerExtension(extension)).toBe(extension)
  })

  test("server extension types remain compatible with the plugin contract", async () => {
    let disposed = false
    const extension: ServerExtension = {
      id: "acme.example",
      async activate() {
        const service: ExtensionService = {
          rpc: {
            "kernel.ping": async (input) => ({ pong: input }),
          },
          dispose: async () => {
            disposed = true
          },
        }
        return service
      },
      async server(input) {
        return {
          rpc: {
            "notebook.echo": async (payload) => ({ directory: input.directory, payload }),
          },
        }
      },
    }
    const defined = defineServerExtension(extension)
    expect(defined.id).toBe("acme.example")

    const service = (await defined.activate!({
      id: "acme.example",
      version: "0.1.0",
      dataDir: "/data",
      cacheDir: "/cache",
      serverUrl: new URL("http://127.0.0.1:4096"),
      settings: { get: () => ({}), onDidChange: () => () => {} },
      setTimeout: () => ({ dispose() {} }),
      setInterval: () => ({ dispose() {} }),
      emit: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    })) as ExtensionService
    expect(await service.rpc!["kernel.ping"]("hello", { signal: new AbortController().signal })).toEqual({
      pong: "hello",
    })
    await service.dispose!()
    expect(disposed).toBe(true)

    const hooks: ExtensionHooks = await defined.server!({
      directory: "/tmp/project",
    } as Parameters<NonNullable<ServerExtension["server"]>>[0])
    const asPlugin: Plugin = () => Promise.resolve(hooks satisfies Hooks)
    expect(typeof asPlugin).toBe("function")
    expect(await hooks.rpc!["notebook.echo"]("save", { signal: new AbortController().signal })).toEqual({
      directory: "/tmp/project",
      payload: "save",
    })
  })
})
