import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSessionListPagination } from "../src/pages/layout/session-list-pagination"

describe("sidebar session list pagination", () => {
  test("isolates project limits and restores them when the sidebar instance is reused", async () => {
    const ctx = createRoot((dispose) => {
      const [state, setState] = createStore({ project: "/project/a" })
      const pagination = createSessionListPagination(() => state.project)
      const visible = createMemo(() => Array.from({ length: 30 }, (_, i) => i).slice(0, pagination.limit()))
      const hasMore = createMemo(() => 30 > pagination.limit())
      return { dispose, setState, pagination, visible, hasMore }
    })

    try {
      expect(ctx.visible()).toHaveLength(10)
      await ctx.pagination.loadMore()
      await ctx.pagination.loadMore()
      expect(ctx.visible()).toHaveLength(20)

      ctx.setState("project", "/project/b")
      expect(ctx.visible()).toHaveLength(10)
      await ctx.pagination.loadMore()
      expect(ctx.visible()).toHaveLength(15)

      ctx.setState("project", "/project/a")
      expect(ctx.visible()).toHaveLength(20)
      await ctx.pagination.loadMore()
      await ctx.pagination.loadMore()
      expect(ctx.hasMore()).toBe(false)

      ctx.setState("project", "/project/b")
      expect(ctx.visible()).toHaveLength(15)
      expect(ctx.hasMore()).toBe(true)
      ctx.setState("project", "/project/c")
      expect(ctx.visible()).toHaveLength(10)
    } finally {
      ctx.dispose()
    }
  })

  test("keeps pagination instances independent and honors custom page sizes", async () => {
    const ctx = createRoot((dispose) => ({
      dispose,
      desktop: createSessionListPagination(() => "/project/a"),
      mobile: createSessionListPagination(() => "/project/a"),
      custom: createSessionListPagination(() => "/project/a", 20, 10),
    }))

    try {
      await ctx.desktop.loadMore()
      expect(ctx.desktop.limit()).toBe(15)
      expect(ctx.mobile.limit()).toBe(10)
      await ctx.custom.loadMore()
      expect(ctx.custom.limit()).toBe(30)
      expect(ctx.desktop.limit()).toBe(15)
    } finally {
      ctx.dispose()
    }
  })
})
