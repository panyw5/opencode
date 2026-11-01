import { expect, test } from "bun:test"
import { FileChange } from "../../src/session/file-change"
import type { MessageV2 } from "../../src/session/message-v2"

const root = "/work/project"
function tool(changes?: FileChange.Record[], extra = {}) {
  return {
    id: "prt_change",
    type: "tool",
    tool: "edit",
    callID: "call_change",
    metadata: changes === undefined ? undefined : { fileChanges: changes },
    state: { status: "completed", input: { filePath: `${root}/owned.txt` }, metadata: {}, time: { start: 1, end: 2 } },
    ...extra,
  } as unknown as MessageV2.ToolPart
}
function assistant(parts: MessageV2.Part[]) {
  return {
    info: { role: "assistant", sessionID: "ses_change", path: { root, cwd: root } },
    parts,
  } as MessageV2.WithParts
}
const change = (before: string | null, after: string | null, file = `${root}/owned.txt`) =>
  FileChange.make({ tool: "edit", file, before, after }, "call_change")

test("ignores workspace patch parts and historical bash metadata.files", () => {
  const messages = [
    assistant([
      tool(undefined, { tool: "bash", state: { status: "completed", metadata: { files: [`${root}/foreign.txt`] } } }),
      { type: "patch", files: [`${root}/foreign.txt`], hash: "workspace" } as MessageV2.PatchPart,
    ]),
  ]
  expect(FileChange.diffs(messages)).toEqual([])
})

test("joins a continuous mutation chain into a net diff", () => {
  const diffs = FileChange.diffs([assistant([tool([change("a\n", "b\n"), change("b\n", "c\n")])])])
  expect(diffs).toHaveLength(1)
  expect(diffs[0]).toMatchObject({
    file: "owned.txt",
    additions: 1,
    deletions: 1,
    attribution: "verified",
    incomplete: false,
  })
  expect(diffs[0]!.patch).toContain("-a\n+c")
  expect(diffs[0]!.operations).toBeUndefined()
})

test("does not invent a net diff across another writer's changes", () => {
  const diffs = FileChange.diffs([assistant([tool([change("a\n", "b\n"), change("b\nFOREIGN\n", "c\nFOREIGN\n")])])])
  expect(diffs[0]!.patch).toBeUndefined()
  expect(diffs[0]!.operations).toHaveLength(2)
  const patches = diffs[0]!.operations!.map((op) => op.patch).join("\n")
  expect(patches).not.toContain("+FOREIGN")
  expect(diffs[0]!.additions).toBe(2)
})

test("does not promote formatter subprocess observations to verified writes", () => {
  const written = change("a\n", "b\n")
  const formatted = FileChange.make(
    { tool: "edit", file: `${root}/owned.txt`, before: "b\n", after: "b\nEXTERNAL\n", source: "formatter" },
    "call_formatter",
  )
  const diffs = FileChange.diffs([assistant([tool([written, formatted])])])
  expect(diffs[0]!.patch).not.toContain("EXTERNAL")
  expect(diffs[0]!.incomplete).toBe(true)
})

test("a verified edit followed by its inverse has no net change", () => {
  expect(FileChange.diffs([assistant([tool([change("a", "b"), change("b", "a")])])])).toEqual([])
})

test("distinguishes an absent file from an existing empty file", () => {
  expect(FileChange.diffs([assistant([tool([change(null, "")])])])[0]!.status).toBe("added")
  expect(FileChange.diffs([assistant([tool([change("", null)])])])[0]!.status).toBe("deleted")
  expect(FileChange.diffs([assistant([tool([change(null, ""), change("", null)])])])).toEqual([])
})

test("keeps actual writes even when a later tool step fails", () => {
  expect(FileChange.diffs([assistant([tool([change("a", "b")], { state: { status: "error" } })])])).toHaveLength(1)
})

test("deduplicates replayed evidence IDs", () => {
  const record = change("a", "b")
  const diffs = FileChange.diffs([assistant([tool([record, record])])])
  expect(diffs[0]!.operations).toBeUndefined()
  expect(diffs[0]!.additions).toBe(1)
})

test("retains independent evidence from Code Mode subcalls", () => {
  const diffs = FileChange.diffs([
    assistant([
      tool([change(null, "a", `${root}/one.txt`), change(null, "b", `${root}/two.txt`)], { tool: "execute" }),
    ]),
  ])
  expect(diffs.map((diff) => diff.file)).toEqual(["one.txt", "two.txt"])
})

test("does not fall back to a workspace diff when content exceeds the evidence limit", () => {
  const record = change("a".repeat(600_000), "b".repeat(600_000))
  expect(record.before).toBeUndefined()
  const diff = FileChange.diffs([assistant([tool([record])])])[0]!
  expect(diff.incomplete).toBe(true)
  expect(diff.patch).toBeUndefined()
  expect(diff.additions).toBe(1)
})

test("uses only the tool-local patch for legacy edit records", () => {
  const diff = FileChange.diffs([
    assistant([
      tool(undefined, {
        state: {
          status: "completed",
          input: { filePath: `${root}/owned.txt` },
          metadata: {
            files: [`${root}/foreign.txt`],
            filediff: { patch: "LOCAL_PATCH", additions: 2, deletions: 1 },
          },
        },
      }),
    ]),
  ])[0]!
  expect(diff).toMatchObject({
    file: "owned.txt",
    patch: "LOCAL_PATCH",
    additions: 2,
    deletions: 1,
    incomplete: true,
    attribution: "legacy",
  })
})

test("malformed new evidence is not replaced with less trustworthy legacy metadata", () => {
  const part = tool(undefined, { metadata: { fileChanges: [{ version: 99 }] } })
  expect(FileChange.diffs([assistant([part])])).toEqual([])
})

test("resolves legacy relative paths using the session cwd, not the repository root", () => {
  const message = assistant([
    tool(undefined, { state: { status: "completed", input: { filePath: "owned.txt" }, metadata: {} } }),
  ])
  if (message.info.role === "assistant") message.info.path.cwd = `${root}/nested`
  expect(FileChange.diffs([message])[0]!.file).toBe("nested/owned.txt")
})
