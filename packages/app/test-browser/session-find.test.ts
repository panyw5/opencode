import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionFind } from "../src/pages/session/timeline/session-find"
import { TimelineRow } from "../src/pages/session/timeline/rows"

const part = (id: string, text: string) => ({ id, type: "text", text }) as any
const setup = (query = "needle", events?: string[]) => {
  const root = document.createElement("div")
  root.innerHTML = `<div data-timeline-key="user-message:message-a"><div data-part-id="part-a">needle here</div><div data-part-id="part-b">needle again</div></div>`
  document.body.append(root)
  const [rows, setRows] = createSignal([new TimelineRow.UserMessage({ userMessageID: "message-a", anchor: true })])
  const navigated: unknown[] = []
  const released: string[] = []
  const [parts, setParts] = createSignal([part("part-a", "needle here"), part("part-b", "needle again")])
  let totalSize = 1000
  let virtualScrolls = 0
  const virtualizer = {
    getVirtualItems: () => [],
    getTotalSize: () => totalSize,
    scrollToIndex: () => {
      virtualScrolls++
    },
  } as any
  const controller = createRoot(() =>
    createSessionFind({
      virtualizer,
      listRoot: () => root as HTMLDivElement,
      timelineRows: () => rows(),
      rowByKey: () => new Map([["user-message:message-a", rows()[0]]]),
      getMessageParts: () => parts(),
      sessionID: () => "session-a",
      onNavigate: (target) => {
        navigated.push(target)
        events?.push("navigate")
      },
      onRelease: (reason) => {
        released.push(reason)
        events?.push("release")
      },
    }),
  )
  if (query) controller.openFind(query)
  return {
    controller,
    root,
    navigated,
    released,
    setParts,
    setRows,
    virtualScrolls: () => virtualScrolls,
    setTotalSize: (value: number) => (totalSize = value),
  }
}

describe("session find viewport contract", () => {
  test("openFind releases before submitting the new find target", () => {
    const events: string[] = []
    const { controller } = setup("", events)
    controller.openFind("needle")
    expect(events).toEqual(["release", "navigate"])
  })

  test("positionMatch is the only operation that writes virtual scroll", () => {
    const { controller, navigated, virtualScrolls } = setup()
    expect(navigated).toHaveLength(1)
    expect(virtualScrolls()).toBe(0)
    expect(controller.positionMatch(navigated[0] as any).available).toBe(true)
  })

  test("rejects stale query versions and missing matches", () => {
    const { controller } = setup()
    const result = controller.positionMatch({
      kind: "find",
      rowKey: "user-message:message-a",
      messageID: "message-a",
      partID: "part-a",
      occurrence: 0,
      query: "needle",
      queryVersion: 99,
    })
    expect(result.available).toBe(false)
    controller.setQuery("")
    expect(controller.count()).toBe(0)
  })

  test("resolves occurrences within the part instead of across the row", () => {
    const { controller, root, navigated } = setup()
    controller.next(1)
    const result = controller.positionMatch({
      kind: "find",
      rowKey: "user-message:message-a",
      messageID: "message-a",
      partID: "part-b",
      occurrence: 0,
      query: "needle",
      queryVersion: (navigated[1] as any).queryVersion,
    })
    expect(result.available).toBe(true)
    expect(root.querySelector('[data-part-id="part-b"]')).not.toBeNull()
  })

  test("same-version next match invalidates the previous match identity", () => {
    const { controller, navigated } = setup()
    const first = navigated[0] as any
    controller.next(1)
    expect(navigated).toHaveLength(2)
    expect((navigated[1] as any).queryVersion).toBe(first.queryVersion)
    expect(controller.positionMatch(first).available).toBe(false)
    expect(controller.positionMatch(navigated[1] as any).available).toBe(true)
  })

  test("close makes the old target stale and deleting a part updates count", () => {
    const { controller, root, released, navigated, setParts } = setup()
    const old = navigated[0] as any
    expect(controller.count()).toBe(2)
    root.querySelector('[data-part-id="part-b"]')?.remove()
    setParts((value) => value.slice(0, 1))
    controller.setQuery("needle-")
    controller.setQuery("needle")
    expect(controller.count()).toBe(1)
    expect(released).toContain("query")
    controller.close()
    expect(released).toContain("close")
    expect(controller.positionMatch(old).available).toBe(false)
  })

  test("centers a mounted match while clamping near the reachable edge", () => {
    const { controller, root, navigated, setTotalSize } = setup()
    setTotalSize(300)
    // Keep the reachable range small enough to exercise end clamping.
    const row = root.querySelector<HTMLElement>("[data-timeline-key]")!
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 100 })
    Object.defineProperty(root, "scrollTop", { configurable: true, writable: true, value: 0 })
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 190, bottom: 240, height: 50, left: 0, right: 100, width: 100 }),
    })
    const result = controller.positionMatch(navigated[0] as any)
    expect(result.available).toBe(true)
    expect(root.scrollTop).toBe(200)
  })

  test("passive row prepend preserves the selected stable match identity", () => {
    const { controller, navigated, setRows } = setup()
    const target = navigated[0] as any
    setRows((rows) => [new TimelineRow.UserMessage({ userMessageID: "message-before", anchor: true }), ...rows])
    expect(controller.positionMatch(target).available).toBe(true)
  })
})
