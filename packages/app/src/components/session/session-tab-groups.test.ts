import { describe, expect, test } from "bun:test"
import {
  collectSessionTabSubtree,
  groupSessionTabs,
  pickSessionTabNeighbor,
  reorderSessionTabGroups,
} from "./session-tab-groups"

type Tab = {
  id: string
  parentID?: string
}

const group = (tabs: Tab[]) =>
  groupSessionTabs(
    tabs,
    (tab) => tab.id,
    (tab) => tab.parentID,
  )

describe("groupSessionTabs", () => {
  test("folds child tabs under their open parent", () => {
    const result = group([
      { id: "parent" },
      { id: "child-a", parentID: "parent" },
      { id: "other" },
      { id: "child-b", parentID: "parent" },
    ])

    expect(result).toEqual([
      {
        tab: { id: "parent" },
        children: [
          { tab: { id: "child-a", parentID: "parent" }, depth: 1 },
          { tab: { id: "child-b", parentID: "parent" }, depth: 1 },
        ],
      },
      { tab: { id: "other" }, children: [] },
    ])
  })

  test("keeps an orphan child visible", () => {
    expect(group([{ id: "child", parentID: "missing" }])).toEqual([
      { tab: { id: "child", parentID: "missing" }, children: [] },
    ])
  })

  test("flattens deeper descendants with their nesting depth", () => {
    expect(group([{ id: "grandchild", parentID: "child" }, { id: "root" }, { id: "child", parentID: "root" }])).toEqual(
      [
        {
          tab: { id: "root" },
          children: [
            { tab: { id: "child", parentID: "root" }, depth: 1 },
            { tab: { id: "grandchild", parentID: "child" }, depth: 2 },
          ],
        },
      ],
    )
  })

  test("does not hide tabs with cyclic parent links", () => {
    expect(
      group([
        { id: "a", parentID: "b" },
        { id: "b", parentID: "a" },
      ]),
    ).toEqual([
      { tab: { id: "a", parentID: "b" }, children: [] },
      { tab: { id: "b", parentID: "a" }, children: [] },
    ])
  })
})

describe("collectSessionTabSubtree", () => {
  test("includes the root and every open descendant", () => {
    const tabs = [
      { id: "other" },
      { id: "parent" },
      { id: "child-a", parentID: "parent" },
      { id: "child-b", parentID: "parent" },
      { id: "grand", parentID: "child-a" },
    ]

    expect(
      collectSessionTabSubtree(
        tabs,
        (tab) => tab.id,
        (tab) => tab.parentID,
        "parent",
      ).map((tab) => tab.id),
    ).toEqual(["parent", "child-a", "grand", "child-b"])
  })

  test("closing a nested parent only collects that branch", () => {
    const tabs = [
      { id: "parent" },
      { id: "child", parentID: "parent" },
      { id: "grand", parentID: "child" },
      { id: "sibling", parentID: "parent" },
    ]

    expect(
      collectSessionTabSubtree(
        tabs,
        (tab) => tab.id,
        (tab) => tab.parentID,
        "child",
      ).map((tab) => tab.id),
    ).toEqual(["child", "grand"])
  })

  test("returns empty when the root tab is not open", () => {
    expect(
      collectSessionTabSubtree(
        [{ id: "child", parentID: "parent" }],
        (tab) => tab.id,
        (tab) => tab.parentID,
        "parent",
      ),
    ).toEqual([])
  })

  test("does not loop on cyclic parent links", () => {
    expect(
      collectSessionTabSubtree(
        [
          { id: "a", parentID: "b" },
          { id: "b", parentID: "a" },
        ],
        (tab) => tab.id,
        (tab) => tab.parentID,
        "a",
      ).map((tab) => tab.id),
    ).toEqual(["a", "b"])
  })
})

describe("reorderSessionTabGroups", () => {
  test("moves complete groups in visible order", () => {
    const groups = group([
      { id: "child", parentID: "parent" },
      { id: "other" },
      { id: "parent" },
      { id: "grandchild", parentID: "child" },
    ])

    const result = reorderSessionTabGroups(groups, "other", "parent", (tab) => tab.id)
    expect(result.flatMap((item) => [item.tab.id, ...item.children.map((child) => child.tab.id)])).toEqual([
      "parent",
      "child",
      "grandchild",
      "other",
    ])
  })

  test("keeps order for unknown and identical targets", () => {
    const groups = group([{ id: "a" }, { id: "b" }])

    expect(reorderSessionTabGroups(groups, "missing", "b", (tab) => tab.id).map((item) => item.tab.id)).toEqual([
      "a",
      "b",
    ])
    expect(reorderSessionTabGroups(groups, "a", "a", (tab) => tab.id).map((item) => item.tab.id)).toEqual(["a", "b"])
  })
})

describe("pickSessionTabNeighbor", () => {
  test("never selects a child tab when closing a root", () => {
    const tabs = [{ id: "left" }, { id: "root" }, { id: "child", parentID: "root" }, { id: "right" }]
    const groups = group(tabs)

    expect(pickSessionTabNeighbor(groups, (tab) => tab.id, new Set(["root"]), "root")?.id).toBe("left")
  })

  test("selects the main-agent parent when closing an active child", () => {
    const tabs = [{ id: "left" }, { id: "root" }, { id: "child", parentID: "root" }, { id: "right" }]
    const groups = group(tabs)

    expect(pickSessionTabNeighbor(groups, (tab) => tab.id, new Set(), "child")?.id).toBe("root")
  })
})
