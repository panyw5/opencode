import { describe, expect, test } from "bun:test"
import { aggregateChangeKinds, buildChangeTree } from "./change-tree-model"

describe("change tree model", () => {
  test("builds directories from changed paths only, in one pass", () => {
    const tree = buildChangeTree([
      { path: "src/app/main.ts", kind: "mix" },
      { path: "src/lib/util.ts", kind: "add" },
      { path: "README.md", kind: "mix" },
    ])

    const src = tree.index.get("src")
    expect(src?.type).toBe("directory")
    expect(src?.children.map((c) => c.name)).toEqual(["app", "lib"]) // dirs-first, sorted

    const app = tree.index.get("src/app")
    expect(app?.children.map((c) => c.path)).toEqual(["src/app/main.ts"])
    expect(tree.index.get("src/app/main.ts")?.type).toBe("file")
    expect(tree.index.get("README.md")?.type).toBe("file")
  })

  test("aggregates kinds up the ancestor chain", () => {
    const tree = buildChangeTree([
      { path: "src/added.ts", kind: "add" },
      { path: "src/deleted.ts", kind: "del" },
      { path: "src/keep.ts", kind: "mix" },
    ])
    expect(tree.index.get("src")?.kind).toBe("mix")
    expect(tree.index.get("src/added.ts")?.kind).toBe("add")
  })

  test("scales linearly: 10000 paths, no per-directory global scans", () => {
    const entries = []
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 100; j++) {
        entries.push({ path: `d${i}/sub${j}/file.ts`, kind: "mix" as const })
      }
    }
    const started = performance.now()
    const tree = buildChangeTree(entries)
    const elapsed = performance.now() - started
    expect(tree.index.get("d0/sub0/file.ts")).toBeDefined()
    // Well under any per-directory×files blowup; generous CI-friendly bound.
    expect(elapsed).toBeLessThan(500)
  })

  test("windows workspaces fold identity case but keep authoritative spelling", () => {
    const tree = buildChangeTree(
      [{ path: "SRC/App.ts", kind: "mix" }, { path: "src/other.ts", kind: "add" }],
      { foldCase: true },
    )
    expect(tree.index.get("src/app.ts")?.path).toBe("SRC/App.ts")
    expect(tree.index.get("src/other.ts")?.path).toBe("src/other.ts")
  })

  test("posix workspaces keep case-sensitive identity", () => {
    const tree = buildChangeTree([{ path: "SRC/App.ts", kind: "mix" }, { path: "src/App.ts", kind: "add" }])
    expect(tree.index.get("SRC/App.ts")).toBeDefined()
    expect(tree.index.get("src/App.ts")).toBeDefined()
  })

  test("keeps POSIX backslash filenames inside one segment", () => {
    const tree = buildChangeTree([{ path: "src/a\\b.ts", kind: "mix" }])
    const node = tree.index.get("src/a\\b.ts")
    expect(node?.type).toBe("file")
    expect(node?.name).toBe("a\\b.ts")
    // The backslash is not a separator: no phantom `a`/`b` segments exist.
    expect(tree.index.get("src/a")).toBeUndefined()
    expect(tree.index.get("src/b.ts")).toBeUndefined()
    expect(tree.index.get("src")?.type).toBe("directory")
  })

  test("logs a conflict instead of merging a file with a directory", () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (message: string) => warnings.push(message)
    try {
      buildChangeTree([{ path: "a/b.ts", kind: "mix" }, { path: "a", kind: "add" }])
    } finally {
      console.warn = original
    }
    expect(warnings.some((w) => w.includes("conflicting paths"))).toBe(true)
  })

  test("aggregateChangeKinds indexes directories for O(1) badge lookup", () => {
    const kinds = aggregateChangeKinds([{ path: "src/app/x.ts", kind: "add" }], {
      platform: "linux",
      kind: "local-filesystem",
    })
    expect(kinds.get("src")).toBe("add")
    expect(kinds.get("src/app")).toBe("add")
    expect(kinds.has("src/app/x.ts")).toBe(false)
  })
})
