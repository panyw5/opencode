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
})

describe("collectSessionReportedFileChanges", () => {
  test("restores explicit generated artifact reports excluded from large-file snapshots", () => {
    expect(
      collectSessionReportedFileChanges([
        {
          id: "prt_1",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: "r=-1 channel completed and checkpoint has been written.\n\ncheckpoint: `artifacts/checkpoints/q40.mx`",
        },
      ] as Part[]),
    ).toEqual([{ file: "artifacts/checkpoints/q40.mx", status: "added" }])
  })

  test("does not treat commands, patterns, or source expressions as files", () => {
    expect(
      collectSessionReportedFileChanges([
        {
          id: "prt_1",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: [
            "Checkpoint saved.",
            "`ClearAll[B, EE, ...]`",
            "`wolframscript -file scripts/run.wls --qMax 40`",
            "`artifacts/checkpoints/q40_xMax{N}_stage_*.mx`",
            "`artifacts/checkpoints/q40.mx`",
          ].join("\n"),
        },
      ] as Part[]),
    ).toEqual([{ file: "artifacts/checkpoints/q40.mx", status: "added" }])
  })

  test("collects completed write and apply-patch tool paths without inferring read tools", () => {
    expect(
      collectSessionReportedFileChanges([
        {
          id: "prt_write",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "tool",
          callID: "call_write",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "scripts/run.wls" },
            output: "",
            title: "",
            time: { start: 1, end: 2 },
          },
        },
        {
          id: "prt_patch",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "tool",
          callID: "call_patch",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: { patchText: "*** Add File: added.ts\n+new\n*** Delete File: removed.ts\n-old" },
            output: "",
            title: "",
            time: { start: 1, end: 2 },
          },
        },
        {
          id: "prt_read",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "tool",
          callID: "call_read",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "not-reported.ts" },
            output: "",
            title: "",
            time: { start: 1, end: 2 },
          },
        },
      ] as never),
    ).toEqual([
      { file: "scripts/run.wls", status: "modified" },
      { file: "added.ts", status: "added" },
      { file: "removed.ts", status: "deleted" },
    ])
  })
})
