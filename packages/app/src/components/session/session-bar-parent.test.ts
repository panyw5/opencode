import { describe, expect, test } from "bun:test"
import { collectMissingAncestorTabs, removeSessionTabSubtree, withParentSessionTab } from "./session-bar-parent"
import type { SessionBarTab } from "@/context/layout"
import { groupSessionTabs } from "./session-tab-groups"

const tab = (id: string, parentID?: string | null): SessionBarTab => ({
  directory: "/proj",
  id,
  title: id,
  parentID,
})

describe("withParentSessionTab", () => {
  test("opens missing parent tab before nesting child", () => {
    const next = withParentSessionTab([tab("other")], "/proj", "parent", 30)
    expect(next.map((item) => item.id)).toEqual(["other", "parent"])
    expect(next.at(-1)).toMatchObject({ id: "parent", directory: "/proj", parentID: undefined })
  })

  test("is a no-op when parent tab already open", () => {
    const prev = [tab("parent"), tab("child", "parent")]
    const next = withParentSessionTab(prev, "/proj", "parent", 30)
    expect(next).toEqual(prev)
  })

  test("respects max tab bound when inserting parent", () => {
    const prev = [tab("a"), tab("b")]
    const next = withParentSessionTab(prev, "/proj", "parent", 2)
    expect(next.map((item) => item.id)).toEqual(["b", "parent"])
  })
})

describe("collectMissingAncestorTabs", () => {
  test("returns nearest-first chain until an open ancestor", () => {
    const byID = new Map([
      ["parent", { id: "parent", title: "Parent", parentID: "root" }],
      ["root", { id: "root", title: "Root" }],
    ])
    const chain = collectMissingAncestorTabs(new Set(["other"]), "parent", byID)
    expect(chain.map((item) => item.id)).toEqual(["parent", "root"])
    expect(chain[0]).toMatchObject({ title: "Parent", parentID: "root" })
    expect(chain[1]).toMatchObject({ title: "Root", parentID: null })
  })

  test("stops when parent is already open", () => {
    const byID = new Map([["parent", { id: "parent", title: "Parent", parentID: "root" }]])
    const chain = collectMissingAncestorTabs(new Set(["parent"]), "parent", byID)
    expect(chain).toEqual([])
  })

  test("handles unknown parent ids without looping", () => {
    const chain = collectMissingAncestorTabs(new Set(), "ghost", new Map())
    expect(chain).toEqual([{ id: "ghost", title: undefined, parentID: undefined }])
  })
})

describe("removeSessionTabSubtree", () => {
  test("closing a parent removes nested children from the tab list", () => {
    const next = removeSessionTabSubtree(
      [tab("other"), tab("parent"), tab("child", "parent"), tab("grand", "child")],
      "/proj",
      "parent",
    )
    expect(next.map((item) => item.id)).toEqual(["other"])
    expect(
      groupSessionTabs(
        next,
        (item) => item.id,
        (item) => (typeof item.parentID === "string" ? item.parentID : undefined),
      ).map((group) => group.tab.id),
    ).toEqual(["other"])
  })

  test("closing a nested child keeps the parent and siblings", () => {
    const next = removeSessionTabSubtree(
      [tab("parent"), tab("child", "parent"), tab("grand", "child"), tab("sibling", "parent")],
      "/proj",
      "child",
    )
    expect(next.map((item) => item.id)).toEqual(["parent", "sibling"])
  })

  test("does not close same-id tabs from another workspace", () => {
    const other: SessionBarTab = { directory: "/other", id: "parent", title: "parent" }
    const next = removeSessionTabSubtree([tab("parent"), tab("child", "parent"), other], "/proj", "parent")
    expect(next).toEqual([other])
  })
})

describe("toast jump nesting scenario", () => {
  test("child folds under auto-opened parent", () => {
    let tabs: SessionBarTab[] = [tab("unrelated")]
    tabs = withParentSessionTab(tabs, "/proj", "parent", 30)
    tabs = [...tabs, tab("child", "parent")]

    const groups = groupSessionTabs(
      tabs,
      (item) => item.id,
      (item) => (typeof item.parentID === "string" ? item.parentID : undefined),
    )

    expect(groups.map((group) => group.tab.id)).toEqual(["unrelated", "parent"])
    expect(groups[1]?.children.map((item) => item.tab.id)).toEqual(["child"])
  })

  test("multi-level ancestors open then nest", () => {
    const byID = new Map([
      ["child", { id: "child", title: "Child", parentID: "mid" }],
      ["mid", { id: "mid", title: "Mid", parentID: "root" }],
      ["root", { id: "root", title: "Root" }],
    ])
    const missing = collectMissingAncestorTabs(new Set(), "mid", byID)
    let tabs: SessionBarTab[] = []
    for (const item of [...missing].reverse()) {
      tabs = [...tabs, { directory: "/proj", id: item.id, title: item.title, parentID: item.parentID }]
    }
    tabs = [...tabs, tab("child", "mid")]

    const groups = groupSessionTabs(
      tabs,
      (item) => item.id,
      (item) => (typeof item.parentID === "string" ? item.parentID : undefined),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.tab.id).toBe("root")
    expect(groups[0]?.children.map((item) => item.tab.id)).toEqual(["mid", "child"])
  })
})
