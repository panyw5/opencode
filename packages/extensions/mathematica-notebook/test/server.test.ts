import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ExtensionPluginInput } from "@opencode-ai/extension-kit/server"
import extension, { createNotebookService, type Document, type ViewerDocument } from "../src/server"
import type { NotebookKernels } from "../src/kernel"
import * as notebook from "../src/notebook"
import { fixture, host } from "./helpers"
const dirs: string[] = []
afterEach(async () => {
  mock.restore()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("read/save/append revisions and conflict protection without Wolfram", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nb-model-"))
  dirs.push(dir)
  const path = join(dir, "test.nb")
  await writeFile(path, fixture)
  const service = createNotebookService(host({ wolframscriptPath: "/does/not/exist" }))
  const ctx = { directory: dir, signal: new AbortController().signal }
  const first = (await service.rpc!["notebook.read"]({ path: "test.nb" }, ctx)) as Document
  expect(first.cells[1].text).toBe("a=6")
  const saved = (await service.rpc!["notebook.save"](
    { path, revision: first.revision, edits: [{ index: 1, text: "a=7" }] },
    ctx,
  )) as Document
  expect(saved.revision).not.toBe(first.revision)
  expect(await readFile(path, "utf8")).not.toContain("CacheID:")
  await expect(
    service.rpc!["notebook.save"]({ path, revision: first.revision, edits: [{ index: 1, text: "a=8" }] }, ctx),
  ).rejects.toThrow("changed on disk")
  expect(await readFile(path, "utf8")).toContain('BoxData["a=7"]')
  const added = (await service.rpc!["notebook.save"](
    { path, revision: saved.revision, edits: [], append: { style: "Text", text: "Added" } },
    ctx,
  )) as Document
  expect(added.cells.at(-1)?.text).toBe("Added")
  await expect(service.rpc!["notebook.run"]({ path, revision: added.revision, index: 4 }, ctx)).rejects.toThrow(
    "not a supported",
  )
  await expect(service.rpc!["notebook.run"]({ path, revision: first.revision, index: 1 }, ctx)).rejects.toThrow(
    "changed on disk",
  )
  await service.dispose!()
})

test("save removes only header CacheID comments, never cell strings or nested comments", async () => {
  const source = `(*CacheID: 234*)\n(* keep (*CacheID: 345*) nested *)\nNotebook[{Cell["untouched (*CacheID: 123*) text", "Text"],Cell[BoxData["Print[\\\"(*CacheID: 99*)\\\"]"], "Input"],Cell["old", "Text"]}]`
  const { dir, path } = await setup(source)
  const service = createNotebookService(host())
  const ctx = { directory: dir, signal: new AbortController().signal }
  try {
    const first = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
    const saved = (await service.rpc!["notebook.save"](
      { path, revision: first.revision, edits: [{ index: 2, text: "new (*CacheID: 777*) text" }] },
      ctx,
    )) as Document
    const actual = await readFile(path, "utf8")
    expect(actual.startsWith("\n(* keep (*CacheID: 345*) nested *)")).toBe(true)
    expect(saved.cells[0].text).toBe(first.cells[0].text)
    expect(saved.cells[1].text).toBe(first.cells[1].text)
    expect(saved.cells[2].text).toBe("new (*CacheID: 777*) text")
    expect(saved.revision).toBe(createHash("sha256").update(actual).digest("hex"))
  } finally {
    await service.dispose!()
  }
})

test("agent exposes read/edit/append, enforces permission prompts and disabled setting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nb-tool-"))
  dirs.push(dir)
  const path = join(dir, "test.nb")
  await writeFile(path, "Notebook[{}]")
  const settings: Record<string, unknown> = {}
  const h = host(settings)
  const service = createNotebookService(h)
  const hooks = await extension.server!({ directory: dir, extension: { ...h, service } } as ExtensionPluginInput)
  const permissions: string[] = []
  const ctx = {
    directory: dir,
    abort: new AbortController().signal,
    ask: async (input: { permission: string }) => {
      permissions.push(input.permission)
    },
  } as never
  const execute = hooks.tool!.mathematica_notebook.execute
  const first = JSON.parse((await execute({ path, action: "read" }, ctx)) as string)
  const next = JSON.parse(
    (await execute({ path, action: "append", revision: first.revision, text: "2+2" }, ctx)) as string,
  )
  expect(next.cells[0].text).toBe("2+2")
  expect(Object.keys(next.cells[0]).sort()).toEqual(["editable", "index", "runnable", "style", "text"])
  expect(permissions).toEqual(["read", "edit"])
  settings.exposeTool = "never"
  await expect(execute({ path, action: "read" }, ctx)).rejects.toThrow("disabled")
  await service.dispose!()
})

test("agent retains edit/run/stop permissions, image attachments and sanitized read outputs", async () => {
  const { dir, path } = await setup('Notebook[{Cell[BoxData["6"],"Input"]}]')
  const { h } = captureHost()
  const output = { ok: true, text: "6", printed: "", image: "cG5n" }
  const service = createNotebookService(h, {
    evaluate: async () => output,
    dispose: async () => {},
    stop: async () => {},
  } as unknown as NotebookKernels)
  const hooks = await extension.server!({ directory: dir, extension: { ...h, service } } as ExtensionPluginInput)
  const permissions: string[] = []
  const ctx = {
    directory: dir,
    abort: new AbortController().signal,
    ask: async (input: { permission: string }) => {
      permissions.push(input.permission)
    },
  } as never
  const execute = hooks.tool!.mathematica_notebook.execute
  const first = JSON.parse((await execute({ path, action: "read" }, ctx)) as string)
  const saved = JSON.parse(
    (await execute({ path, action: "edit", revision: first.revision, index: 0, text: "7" }, ctx)) as string,
  )
  const run = (await execute({ path, action: "run", revision: saved.revision, index: 0 }, ctx)) as {
    output: string
    attachments: { url: string }[]
  }
  expect(JSON.parse(run.output)).toEqual({ ok: true, text: "6", printed: "" })
  expect(run.attachments[0].url).toBe("data:image/png;base64,cG5n")
  const after = JSON.parse((await execute({ path, action: "read" }, ctx)) as string)
  expect(after.outputs[0].image).toBe("PNG available; run cell to receive image attachment")
  expect(Object.keys(after.cells[0]).sort()).toEqual(["editable", "index", "runnable", "style", "text"])
  expect(JSON.parse((await execute({ path, action: "stop" }, ctx)) as string)).toEqual({ stopped: true })
  expect(permissions).toEqual(["read", "edit", "bash", "read", "bash"])
  await service.dispose!()
})

function captureHost() {
  const h = host()
  const logs: { message: string; data: Record<string, number | string> }[] = []
  h.log.info = (message, data) => {
    logs.push({ message, data: data as Record<string, number | string> })
  }
  h.log.debug = () => {}
  h.log.error = () => {}
  h.emit = () => {}
  return { h, logs }
}

async function setup(source = fixture) {
  const dir = await mkdtemp(join(tmpdir(), "nb-server-"))
  dirs.push(dir)
  const path = join(dir, "test.nb")
  await writeFile(path, source)
  return { dir, path, ctx: { directory: dir, signal: new AbortController().signal } }
}

const sha = (source: string | Uint8Array) => createHash("sha256").update(source).digest("hex")

test("viewer read/save use slim DTOs while legacy read keeps raw text and offsets", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  const legacy = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
  expect(legacy.cells[1].raw).toContain("Cell[")
  expect(legacy.cells[1].start).toBeGreaterThan(0)
  const view = (await service.rpc!["notebook.read"]({ path, view: true }, ctx)) as ViewerDocument
  expect(view.revision).toBe(legacy.revision)
  expect(view.cells[1]).toEqual({ index: 1, style: "Input", text: "a=6", editable: true, runnable: true })
  for (const cell of view.cells)
    expect(Object.keys(cell).sort()).toEqual(["editable", "index", "runnable", "style", "text"])
  expect(logs.at(-1)?.data.cacheHits).toBe(1)
  expect(logs.at(-1)?.data.parseMs).toBe(0)
  expect(logs.at(-1)?.data.bytes).toBe(Buffer.byteLength(fixture))
  const saved = (await service.rpc!["notebook.save"](
    {
      path,
      revision: view.revision,
      view: true,
      edits: [{ index: 1, text: "a=8" }],
    },
    ctx,
  )) as ViewerDocument
  const disk = await readFile(path, "utf8")
  expect(disk).not.toContain("CacheID:")
  expect(saved.revision).toBe(sha(disk))
  expect(saved.cells[1].text).toBe("a=8")
  expect(Object.keys(saved.cells[1]).sort()).toEqual(["editable", "index", "runnable", "style", "text"])
  expect(logs.at(-1)?.data.cacheHits).toBe(1)
  expect(logs.at(-1)?.data.cacheMisses).toBe(1)
  const after = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
  expect(after.cells[1].raw).toContain('BoxData["a=8"]')
  expect(disk.slice(after.cells[1].start, after.cells[1].end)).toBe('BoxData["a=8"]')
  expect(logs.at(-1)?.data.parseMs).toBe(0)
  expect(JSON.stringify(logs)).not.toContain("RowBox")
  await service.dispose!()
})

test("every external read and run hashes current content including same-size rewrites", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const evaluate = mock(async () => ({ ok: true, text: "6", printed: "" }))
  const kernels = { evaluate, dispose: async () => {}, stop: async () => {} } as unknown as NotebookKernels
  const service = createNotebookService(h, kernels)
  const first = (await service.rpc!["notebook.read"]({ path, view: true }, ctx)) as ViewerDocument
  await writeFile(path, fixture.replace('"6"', '"7"'))
  const changed = (await service.rpc!["notebook.read"]({ path, view: true }, ctx)) as ViewerDocument
  expect(changed.revision).not.toBe(first.revision)
  expect(changed.cells[1].text).toBe("a=7")
  expect(logs.at(-1)?.data.cacheMisses).toBe(1)
  await expect(service.rpc!["notebook.run"]({ path, revision: first.revision, index: 1 }, ctx)).rejects.toThrow(
    "changed on disk",
  )
  expect(evaluate).not.toHaveBeenCalled()
  await service.rpc!["notebook.run"]({ path, revision: changed.revision, index: 1 }, ctx)
  expect(evaluate).toHaveBeenCalledTimes(1)
  expect(logs.at(-1)?.data.cacheHits).toBe(1)
  await service.dispose!()
})

test("cancelled/failed reads do not populate cache or cancel another simultaneous read", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  const controller = new AbortController()
  const original = fs.readFile
  const readSpy = spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const signal = (args[1] as { signal: AbortSignal }).signal
    if (signal === controller.signal) {
      controller.abort()
      signal.throwIfAborted()
    }
    return original(...args)
  }) as typeof fs.readFile)
  const cancelled = service.rpc!["notebook.read"]({ path }, { ...ctx, signal: controller.signal })
  const healthy = service.rpc!["notebook.read"]({ path, view: true }, ctx)
  const results = await Promise.allSettled([cancelled, healthy])
  expect(results[0].status).toBe("rejected")
  expect(results[1].status).toBe("fulfilled")
  expect((results[1] as PromiseFulfilledResult<ViewerDocument>).value.cells.length).toBe(6)
  const cancellation = logs.find((log) => log.data.status === "cancelled")!
  expect(cancellation.data.cacheMisses).toBe(0)
  readSpy.mockRestore()
  await service.rpc!["notebook.read"]({ path }, ctx)
  expect(logs.at(-1)?.data.cacheHits).toBe(1)
  expect(logs.at(-1)?.data.cacheEntries).toBe(1)
  await writeFile(path, "not a notebook")
  await expect(service.rpc!["notebook.read"]({ path }, ctx)).rejects.toThrow()
  expect(logs.at(-1)?.data.cacheEntries).toBe(1)
  await service.dispose!()
  await expect(service.rpc!["notebook.read"]({ path }, ctx)).rejects.toThrow("stopped")
  expect(logs.at(-1)?.data.cacheEntries).toBe(0)
})

test("abort immediately after I/O skips hash/parse/cache and is checked again before DTO", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  const original = fs.readFile
  const controller = new AbortController()
  const readSpy = spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await original(...args)
    controller.abort()
    return bytes
  }) as typeof fs.readFile)
  await expect(service.rpc!["notebook.read"]({ path }, { ...ctx, signal: controller.signal })).rejects.toThrow()
  expect(logs.at(-1)?.data.hashMs).toBe(0)
  expect(logs.at(-1)?.data.parseMs).toBe(0)
  expect(logs.at(-1)?.data.cacheEntries).toBe(0)
  readSpy.mockRestore()
  const originalParse = notebook.parseNotebook
  const afterParse = new AbortController()
  spyOn(notebook, "parseNotebook").mockImplementation((source) => {
    const result = originalParse(source)
    afterParse.abort()
    return result
  })
  await expect(service.rpc!["notebook.read"]({ path }, { ...ctx, signal: afterParse.signal })).rejects.toThrow()
  expect(logs.at(-1)?.data.cacheMisses).toBe(1)
  expect(logs.at(-1)?.data.dtoMs).toBe(0)
  expect(logs.at(-1)?.data.cacheEntries).toBe(0)
  await service.dispose!()
})

test("20 MB is checked before reading and again after file growth", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  const file = await fs.open(path, "r+")
  await file.truncate(20 * 1024 * 1024 + 1)
  await file.close()
  const original = fs.readFile
  const readSpy = spyOn(fs, "readFile")
  await expect(service.rpc!["notebook.read"]({ path }, ctx)).rejects.toThrow("20 MB")
  expect(readSpy).not.toHaveBeenCalled()
  await writeFile(path, fixture)
  readSpy.mockImplementation((async () => Buffer.alloc(20 * 1024 * 1024 + 1)) as typeof fs.readFile)
  await expect(service.rpc!["notebook.read"]({ path }, ctx)).rejects.toThrow("20 MB")
  expect(logs.at(-1)?.data.cacheEntries).toBe(0)
  readSpy.mockRestore()
  expect(fs.readFile).toBe(original)
  await service.dispose!()
})

test("second conflict check, save lock and atomic replacement preserve external edits", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  const first = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
  const original = fs.readFile
  let reads = 0
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const secondRead = new Promise<void>((resolve) => {
    reached = resolve
  })
  const external = fixture.replace('"6"', '"9"')
  spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (++reads === 2) {
      await writeFile(path, external)
      reached()
      await gate
    }
    return original(...args)
  }) as typeof fs.readFile)
  const save = service.rpc!["notebook.save"](
    { path, revision: first.revision, edits: [{ index: 1, text: "a=8" }] },
    ctx,
  )
  const rejected = save.catch((error) => error)
  await Promise.race([
    secondRead,
    save.then(() => {
      throw new Error("save skipped second read")
    }),
  ])
  await expect(service.rpc!["notebook.save"]({ path, revision: first.revision, edits: [] }, ctx)).rejects.toThrow(
    "being saved",
  )
  release()
  expect(String(await rejected)).toContain("while saving")
  expect(await original(path, "utf8")).toBe(external)
  expect((await fs.readdir(ctx.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  expect(logs.at(-1)?.data.cacheEntries).toBe(1)
  await service.dispose!()
})

test("concurrent reads parse each SHA once without sharing request cancellation", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  const documents = (await Promise.all(
    Array.from({ length: 4 }, () => service.rpc!["notebook.read"]({ path, view: true }, ctx)),
  )) as ViewerDocument[]
  expect(new Set(documents.map((document) => document.revision)).size).toBe(1)
  expect(logs.reduce((misses, log) => misses + Number(log.data.cacheMisses), 0)).toBe(1)
  expect(logs.reduce((hits, log) => hits + Number(log.data.cacheHits), 0)).toBe(3)
  await service.dispose!()
})

test("service cache evicts the least-recently-read SHA after eight entries", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  for (let i = 0; i < 9; i++) {
    await writeFile(path, `Notebook[{Cell["version ${i}","Text"]}]`)
    await service.rpc!["notebook.read"]({ path, view: true }, ctx)
  }
  expect(logs.at(-1)?.data.cacheEntries).toBe(8)
  await writeFile(path, 'Notebook[{Cell["version 0","Text"]}]')
  await service.rpc!["notebook.read"]({ path }, ctx)
  expect(logs.at(-1)?.data.cacheMisses).toBe(1)
  expect(logs.at(-1)?.data.cacheEntries).toBe(8)
  await service.dispose!()
})

test("cancelled save keeps original bytes, cleans temporary file and does not cache its parse", async () => {
  const { path, ctx } = await setup()
  const { h, logs } = captureHost()
  const service = createNotebookService(h)
  const first = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
  const controller = new AbortController()
  const original = fs.readFile
  let reads = 0
  spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (++reads === 2) controller.abort()
    return original(...args)
  }) as typeof fs.readFile)
  await expect(
    service.rpc!["notebook.save"](
      { path, revision: first.revision, edits: [{ index: 1, text: "cancelled edit" }] },
      { ...ctx, signal: controller.signal },
    ),
  ).rejects.toThrow()
  expect(await original(path, "utf8")).toBe(fixture)
  expect((await fs.readdir(ctx.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  expect(logs.at(-1)?.data.status).toBe("cancelled")
  expect(logs.at(-1)?.data.cacheEntries).toBe(1)
  await service.dispose!()
})

test("save validates and returns the actual UTF-8 bytes for unpaired surrogate edits", async () => {
  const { path, ctx } = await setup()
  const service = createNotebookService(captureHost().h)
  const first = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
  const saved = (await service.rpc!["notebook.save"](
    { path, revision: first.revision, edits: [{ index: 1, text: "\ud800" }] },
    ctx,
  )) as Document
  const bytes = await readFile(path)
  expect(saved.revision).toBe(sha(bytes))
  expect(saved.cells[1].text).toBe("�")
  expect(((await service.rpc!["notebook.read"]({ path }, ctx)) as Document).cells).toEqual(saved.cells)
  await service.dispose!()
})

test("outputs are scoped to actual revision and invalidated after save", async () => {
  const { path, ctx } = await setup('Notebook[{Cell[BoxData["6"],"Input"]}]')
  const { h } = captureHost()
  const output = { ok: true, text: "6", printed: "" }
  const service = createNotebookService(h, {
    evaluate: async () => output,
    dispose: async () => {},
    stop: async () => {},
  } as unknown as NotebookKernels)
  const first = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
  await service.rpc!["notebook.run"]({ path, revision: first.revision, index: 0 }, ctx)
  expect(((await service.rpc!["notebook.read"]({ path, view: true }, ctx)) as ViewerDocument).outputs[0]).toEqual(
    output,
  )
  await writeFile(path, 'Notebook[{Cell[BoxData["7"],"Input"]}]')
  const changed = (await service.rpc!["notebook.read"]({ path }, ctx)) as Document
  expect(changed.outputs).toEqual({})
  await service.rpc!["notebook.run"]({ path, revision: changed.revision, index: 0 }, ctx)
  const saved = (await service.rpc!["notebook.save"](
    { path, revision: changed.revision, edits: [{ index: 0, text: "8" }], view: true },
    ctx,
  )) as ViewerDocument
  expect(saved.outputs).toEqual({})
  expect(((await service.rpc!["notebook.read"]({ path }, ctx)) as Document).outputs).toEqual({})
  await service.dispose!()
})
