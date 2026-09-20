import { expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { collectSessionEditedFiles, filterSessionDiffs } from "../../src/session/summary"

const root = "/work/project"

function assistant(parts: MessageV2.Part[]) {
  return {
    info: {
      role: "assistant",
      sessionID: "ses_summary_test",
      path: { cwd: root, root },
    },
    parts,
  } as unknown as MessageV2.WithParts
}

function tool(tool: string, metadata: Record<string, unknown>, input: Record<string, unknown> = {}) {
  return {
    type: "tool",
    tool,
    state: {
      status: "completed",
      input,
      metadata,
    },
  } as unknown as MessageV2.ToolPart
}

test("collects only files explicitly reported by completed mutation tools", () => {
  const files = collectSessionEditedFiles([
    assistant([
      tool("read", {}, { filePath: `${root}/read-only.md` }),
      tool("write", { filepath: `${root}/written.md` }),
      tool("bash", { files: [`${root}/generated-by-script.md`] }),
      tool("apply_patch", {
        files: [{ filePath: `${root}/old.md`, movePath: `${root}/new.md` }, { filePath: `${root}/deleted.md` }],
      }),
    ]),
  ])

  expect([...files].sort()).toEqual([
    `${root}/deleted.md`,
    `${root}/generated-by-script.md`,
    `${root}/new.md`,
    `${root}/old.md`,
    `${root}/written.md`,
  ])
})

test("does not attribute a concurrent file change to a read-only session", () => {
  const files = collectSessionEditedFiles([assistant([tool("read", {}, { filePath: `${root}/第 14 节-polished.md` })])])

  const diffs = [
    { file: `${root}/第 14 节-polished.md`, additions: 6, deletions: 6, status: "modified" as const },
    { file: `${root}/owned.md`, additions: 1, deletions: 0, status: "added" as const },
  ]

  expect(files.size).toBe(0)
  expect(filterSessionDiffs(diffs, files)).toEqual([])
})

test("keeps a diff for a file reported by the current session", () => {
  const files = collectSessionEditedFiles([assistant([tool("edit", {}, { filePath: `${root}/owned.md` })])])
  const diff = { file: `${root}/owned.md`, additions: 1, deletions: 1, status: "modified" as const }

  expect(filterSessionDiffs([diff], files)).toEqual([diff])
})
