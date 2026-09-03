import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { Part } from "@opencode-ai/sdk/v2/client"
import {
  collectSessionFileChanges,
  collectSessionReportedFileChanges,
  normalizeSessionFilePath,
} from "./session-file-changes"

const diff = (file: string | undefined, status?: SnapshotFileDiff["status"]): SnapshotFileDiff => ({
  file,
  additions: 0,
  deletions: 0,
  status,
})

const completedTool = (tool: string, state: Record<string, unknown>) =>
  ({
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool,
    state: {
      status: "completed",
      output: "",
      title: "",
      time: { start: 1, end: 2 },
      ...state,
    },
  }) as never as Part

describe("collectSessionFileChanges", () => {
  test("groups and sorts changed files by their current snapshot status", () => {
    expect(
      collectSessionFileChanges([
        diff("src/z.ts", "modified"),
        diff("docs/guide.md", "added"),
        diff("src/a.ts", "modified"),
        diff("obsolete.ts", "deleted"),
      ]),
    ).toEqual({
      added: ["docs/guide.md"],
      modified: ["src/a.ts", "src/z.ts"],
      deleted: ["obsolete.ts"],
    })
  })

  test("uses the newest status for duplicate files and treats legacy diffs as modified", () => {
    expect(
      collectSessionFileChanges([
        diff("src/replaced.ts", "added"),
        diff("src/replaced.ts", "modified"),
        diff("legacy.ts"),
        diff(undefined, "deleted"),
        diff("   ", "added"),
      ]),
    ).toEqual({
      added: [],
      modified: ["legacy.ts", "src/replaced.ts"],
      deleted: [],
    })
  })

  test("keeps the authoritative snapshot status over a recovered historical report", () => {
    expect(
      collectSessionFileChanges([diff("artifact.mx", "added")], [{ file: "artifact.mx", status: "modified" }]),
    ).toEqual({
      added: ["artifact.mx"],
      modified: [],
      deleted: [],
    })
  })

  test("the latest reported action wins for the same file", () => {
    expect(
      collectSessionFileChanges(
        [],
        [
          { file: "created-then-removed.ts", status: "added" },
          { file: "created-then-removed.ts", status: "deleted" },
          { file: "edited-later.ts", status: "added" },
          { file: "edited-later.ts", status: "modified" },
        ],
      ),
    ).toEqual({
      added: [],
      modified: ["edited-later.ts"],
      deleted: ["created-then-removed.ts"],
    })
  })

  test("snapshot diffs still override the latest report in git projects", () => {
    expect(
      collectSessionFileChanges([diff("kept.ts", "modified")], [
        { file: "kept.ts", status: "added" },
        { file: "only-reported.ts", status: "added" },
      ]),
    ).toEqual({
      added: ["only-reported.ts"],
      modified: ["kept.ts"],
      deleted: [],
    })
  })

  test("deduplicates project-relative paths, selections, and absolute paths", () => {
    expect(
      collectSessionFileChanges(
        [diff(".trellis/tasks/task/prd.md", "modified")],
        [
          { file: ".trellis/tasks/task/prd.md:1-29", status: "added" },
          { file: "/.trellis/tasks/task/prd.md", status: "added" },
          { file: "/work/project/.trellis/tasks/task/prd.md", status: "added" },
        ],
        "/work/project",
      ),
    ).toEqual({
      added: [],
      modified: [".trellis/tasks/task/prd.md"],
      deleted: [],
    })
  })
})

describe("normalizeSessionFilePath", () => {
  test("preserves external absolute paths", () => {
    expect(normalizeSessionFilePath("/tmp/output.mx", "/work/project")).toBe("/tmp/output.mx")
  })

  test("strips the worktree prefix from absolute tool metadata paths", () => {
    expect(normalizeSessionFilePath("/work/project/src/app.ts", "/work/project")).toBe("src/app.ts")
  })
})

describe("collectSessionReportedFileChanges", () => {
  test("reads apply_patch metadata files including move semantics", () => {
    expect(
      collectSessionReportedFileChanges([
        completedTool("apply_patch", {
          input: { patchText: "*** Add File: ignored.ts\n+stale" },
          metadata: {
            files: [
              { filePath: "/work/project/added.ts", relativePath: "added.ts", type: "add" },
              { filePath: "/work/project/updated.ts", relativePath: "updated.ts", type: "update" },
              { filePath: "/work/project/removed.ts", relativePath: "removed.ts", type: "delete" },
              {
                filePath: "/work/project/old-name.ts",
                relativePath: "new-name.ts",
                type: "move",
                movePath: "/work/project/new-name.ts",
              },
            ],
          },
        }),
      ]),
    ).toEqual([
      { file: "added.ts", status: "added" },
      { file: "updated.ts", status: "modified" },
      { file: "removed.ts", status: "deleted" },
      { file: "/work/project/old-name.ts", status: "deleted" },
      { file: "new-name.ts", status: "added" },
    ])
  })

  test("falls back to patchText parsing for legacy apply_patch parts without metadata", () => {
    expect(
      collectSessionReportedFileChanges([
        completedTool("apply_patch", {
          input: { patchText: "*** Add File: added.ts\n+new\n*** Delete File: removed.ts\n-old" },
          metadata: {},
        }),
      ]),
    ).toEqual([
      { file: "added.ts", status: "added" },
      { file: "removed.ts", status: "deleted" },
    ])
  })

  test("reads edit metadata filediff as a modified file", () => {
    expect(
      collectSessionReportedFileChanges([
        completedTool("edit", {
          input: { filePath: "/work/project/src/app.ts" },
          metadata: { filediff: { file: "/work/project/src/app.ts", additions: 2, deletions: 1 } },
        }),
      ]),
    ).toEqual([{ file: "/work/project/src/app.ts", status: "modified" }])
  })

  test("distinguishes added from modified writes via write metadata", () => {
    expect(
      collectSessionReportedFileChanges([
        completedTool("write", {
          input: { filePath: "/work/project/new.ts" },
          metadata: { filepath: "/work/project/new.ts", exists: false },
        }),
        completedTool("write", {
          input: { filePath: "/work/project/existing.ts" },
          metadata: { filepath: "/work/project/existing.ts", exists: true },
        }),
      ]),
    ).toEqual([
      { file: "/work/project/new.ts", status: "added" },
      { file: "/work/project/existing.ts", status: "modified" },
    ])
  })

  test("falls back to tool input for legacy write parts without metadata", () => {
    expect(
      collectSessionReportedFileChanges([
        completedTool("write", {
          input: { filePath: "scripts/run.wls" },
          metadata: {},
        }),
      ]),
    ).toEqual([{ file: "scripts/run.wls", status: "modified" }])
  })

  test("never infers files from assistant text or read tools", () => {
    expect(
      collectSessionReportedFileChanges([
        {
          id: "prt_text",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: "Checkpoint saved. Generated `artifacts/checkpoints/q40.mx` and updated `src/app.ts`.",
        },
        completedTool("read", {
          input: { filePath: "not-a-write.ts" },
          metadata: {},
        }),
      ]),
    ).toEqual([])
  })

  test("ignores tools that did not complete", () => {
    expect(
      collectSessionReportedFileChanges([
        {
          id: "prt_1",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "tool",
          callID: "call_1",
          tool: "write",
          state: {
            status: "error",
            input: { filePath: "failed.ts" },
            error: "denied",
            metadata: { filepath: "failed.ts", exists: false },
            time: { start: 1, end: 2 },
          },
        },
      ] as never),
    ).toEqual([])
  })
})
