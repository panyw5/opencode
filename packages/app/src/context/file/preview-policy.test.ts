import { expect, test } from "bun:test"
import { createFilePreviewPreparer, filePreviewContent } from "./preview-policy"

test("only the highest-priority replace viewer can opt out of text", () => {
  expect(filePreviewContent([])).toBe("text")
  expect(filePreviewContent([{ mode: "preview", content: "self" }])).toBe("text")
  expect(filePreviewContent([{ mode: "replace" }])).toBe("text")
  expect(
    filePreviewContent([
      { mode: "preview", content: "self" },
      { mode: "replace", content: "text" },
      { mode: "replace", content: "self" },
    ]),
  ).toBe("text")
  expect(
    filePreviewContent([
      { mode: "preview", content: "text" },
      { mode: "replace", content: "self" },
      { mode: "replace", content: "text" },
    ]),
  ).toBe("self")
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(ready = Promise.resolve()) {
  let scope = "/repo"
  let client: unknown = {}
  let self = true
  const ensured: string[] = []
  const reads: Array<{ file: string; force?: boolean }> = []
  const revisions: string[] = []
  const load = async (file: string, options?: { force?: boolean }) => {
    reads.push({ file, force: options?.force })
  }
  const preview = createFilePreviewPreparer({
    scope: () => scope,
    client: () => client,
    normalize: (input) => input.replace(/^\.\//, ""),
    whenReady: () => ready,
    ensure: (file) => ensured.push(file),
    self: () => self,
    load,
    refreshSelf: async (file) => {
      revisions.push(file)
    },
  })
  return {
    preview,
    load,
    ensured,
    reads,
    revisions,
    setScope: (value: string) => {
      scope = value
    },
    setClient: (value: unknown) => {
      client = value
    },
    setSelf: (value: boolean) => {
      self = value
    },
  }
}

test("self preview ensures metadata without full text or a fabricated loaded state", async () => {
  const state = setup()
  await state.preview.prepare("./notebook.nb")
  expect(state.ensured).toEqual(["notebook.nb"])
  expect(state.reads).toEqual([])
  expect(state.revisions).toEqual([])
  await state.preview.prepare("notebook.nb", { force: true })
  expect(state.reads).toEqual([])
  expect(state.revisions).toEqual(["notebook.nb"])
})

test("text preview and explicit source reads retain full-text force semantics", async () => {
  const state = setup()
  state.setSelf(false)
  await state.preview.prepare("notebook.nb", { force: true })
  expect(state.reads).toEqual([{ file: "notebook.nb", force: true }])
  state.setSelf(true)
  await state.load("notebook.nb")
  expect(state.reads).toEqual([
    { file: "notebook.nb", force: true },
    { file: "notebook.nb", force: undefined },
  ])
})

test("preparation waits for delayed viewer manifest before deciding content policy", async () => {
  const ready = deferred()
  const state = setup(ready.promise)
  state.setSelf(false)
  const pending = state.preview.prepare("notebook.nb")
  expect(state.ensured).toEqual([])
  expect(state.reads).toEqual([])
  state.setSelf(true)
  ready.resolve()
  await pending
  expect(state.ensured).toEqual(["notebook.nb"])
  expect(state.reads).toEqual([])
})

test("failed manifest readiness settles and falls back to available text viewer", async () => {
  const ready = deferred()
  const state = setup(ready.promise)
  state.setSelf(false)
  const pending = state.preview.prepare("source.txt")
  ready.reject(new Error("manifest failed"))
  await pending
  expect(state.reads).toEqual([{ file: "source.txt", force: undefined }])
})

test("directory, same-directory client and reset discard delayed preparations", async () => {
  for (const change of [
    (state: ReturnType<typeof setup>) => state.setScope("/next"),
    (state: ReturnType<typeof setup>) => state.setClient({}),
    (state: ReturnType<typeof setup>) => state.preview.reset(),
    (state: ReturnType<typeof setup>) => {
      state.setScope("/next")
      state.preview.reset()
      state.setScope("/repo")
    },
  ]) {
    const ready = deferred()
    const state = setup(ready.promise)
    state.setSelf(false)
    const pending = state.preview.prepare("same.txt", { force: true })
    change(state)
    ready.resolve()
    await pending
    expect(state.ensured).toEqual([])
    expect(state.reads).toEqual([])
  }
})
