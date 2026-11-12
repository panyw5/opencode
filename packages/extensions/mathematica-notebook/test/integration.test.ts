import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import extension, { createNotebookService, type Document } from "../src/server"
import type { ExtensionPluginInput } from "@opencode-ai/extension-kit/server"
import type { Output } from "../src/kernel"
import { host } from "./helpers"

test.skipIf(process.env.WOLFRAM_INTEGRATION !== "1")(
  "real Wolfram notebook cells, graphics, timeout, stop and agent shared state",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "nb-integration-"))
    const path = join(dir, "real.nb")
    await writeFile(
      path,
      'Notebook[{Cell[BoxData["q = 6"], "Input"], Cell[BoxData["q * 7"], "Input"], Cell[BoxData["Print[\\"hello notebook\\"]; Plot[Sin[x], {x, 0, 6}]"], "Input"]}]',
    )
    const settings = { wolframscriptPath: "/usr/local/bin/wolframscript", timeoutSeconds: 20 }
    const h = host(settings)
    const service = createNotebookService(h)
    const ctx = { directory: dir, signal: new AbortController().signal }
    const run = async (index: number, code?: string) =>
      service.rpc!["notebook.run"]({ path, revision: document.revision, index, code }, ctx) as Promise<Output>
    const document = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
    try {
      const first = await run(0)
      expect(first.text).toBe("6")
      expect(first).toEqual(JSON.parse(JSON.stringify(first)))
      expect((await run(1)).text).toBe("42")
      const plot = await run(2)
      expect(plot.ok).toBe(true)
      expect(plot.printed).toContain("hello notebook")
      expect(plot.image?.startsWith("iVBOR")).toBe(true)
      const hooks = await extension.server!({ directory: dir, extension: { ...h, service } } as ExtensionPluginInput)
      const output = await hooks.tool!.cells.execute(
        { path, action: "run", index: 1, revision: document.revision },
        { directory: dir, abort: ctx.signal, ask: async () => {} } as never,
      )
      expect(JSON.parse(output as string).text).toBe("42")
      settings.timeoutSeconds = 1
      expect((await run(0, "Pause[5]")).ok).toBe(false)
      expect((await run(0, "1+")).ok).toBe(false)
      settings.timeoutSeconds = 20
      const pending = run(0, "Pause[10]")
      const stopped = pending.then(
        () => "unexpected success",
        (error: Error) => error.message,
      )
      await Bun.sleep(200)
      await service.rpc!["kernel.stop"]({ path }, ctx)
      expect(await stopped).toContain("stopped")
      expect((await run(0, "q")).text).toContain("q")
    } finally {
      await service.dispose!()
      await rm(dir, { recursive: true, force: true })
    }
  },
  120_000,
)
