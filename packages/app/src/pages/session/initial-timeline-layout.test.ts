import { describe, expect, test } from "bun:test"
import {
  cachedTimelineLayoutReady,
  initialTimelineLayoutReady,
  inspectCachedTimelineLayout,
} from "./initial-timeline-layout"

function fixture() {
  const root = document.createElement("div")
  root.innerHTML =
    '<div data-timeline-key="last"><div data-component="markdown" data-markdown-stage="full"></div></div>'
  const row = root.firstElementChild as HTMLElement
  const markdown = row.firstElementChild as HTMLElement
  root.getBoundingClientRect = () => ({ top: 0, bottom: 800 }) as DOMRect
  row.getBoundingClientRect = () => ({ top: 0, bottom: 1000 }) as DOMRect
  markdown.getClientRects = () => [{ top: 0, bottom: 1000 }] as unknown as DOMRectList
  return { root, row, markdown }
}

describe("initial timeline layout", () => {
  test("waits for visible async Markdown, including lite-to-full upgrades", () => {
    const { root, markdown } = fixture()
    expect(initialTimelineLayoutReady(root)).toBe(false)
    markdown.dataset.markdownRenderedStage = "lite"
    expect(initialTimelineLayoutReady(root)).toBe(false)
    markdown.dataset.markdownRenderedStage = "full"
    expect(initialTimelineLayoutReady(root)).toBe(true)
  })

  test("does not wait for offscreen overscan Markdown", () => {
    const { root, markdown } = fixture()
    markdown.dataset.markdownRenderedStage = "full"
    const offscreen = root.firstElementChild!.cloneNode(true) as HTMLElement
    offscreen.querySelector<HTMLElement>('[data-component="markdown"]')!.dataset.markdownRenderedStage = "lite"
    offscreen.getBoundingClientRect = () => ({ top: -1000, bottom: 0 }) as DOMRect
    root.append(offscreen)
    expect(initialTimelineLayoutReady(root)).toBe(true)
  })

  test("waits while the virtual range has not caught up with the physical viewport", () => {
    const { root, row } = fixture()
    row.getBoundingClientRect = () => ({ top: 900, bottom: 1000 }) as DOMRect
    expect(initialTimelineLayoutReady(root)).toBe(false)
  })

  test("allows empty sessions and visible rows without Markdown", () => {
    expect(initialTimelineLayoutReady(document.createElement("div"))).toBe(true)
    const { root, markdown } = fixture()
    markdown.remove()
    expect(initialTimelineLayoutReady(root)).toBe(true)
    console.info("[initial-layout-test] asyncMarkdown=true offscreenIgnored=true emptySession=true")
  })

  test("a deferred visible tool skeleton is not complete cached content", () => {
    const { root, markdown } = fixture()
    markdown.dataset.markdownRenderedStage = "full"
    markdown.dataset.toolPlaceholder = "true"
    expect(initialTimelineLayoutReady(root)).toBe(false)
    expect(inspectCachedTimelineLayout(root, () => 1000).reason).toBe("content-pending")
    delete markdown.dataset.toolPlaceholder
    expect(initialTimelineLayoutReady(root)).toBe(true)
  })
})

describe("cached timeline layout", () => {
  test("hidden collapsed Markdown does not block valid visible cached content", () => {
    const { root, row, markdown } = fixture()
    markdown.dataset.markdownRenderedStage = "full"
    Object.defineProperty(markdown, "offsetHeight", { value: 1000 })
    const hidden = document.createElement("div")
    hidden.dataset.component = "markdown"
    hidden.dataset.markdownFallback = "true"
    hidden.getClientRects = () => [] as unknown as DOMRectList
    row.append(hidden)
    expect(cachedTimelineLayoutReady(root, () => 1000)).toBe(true)
    hidden.getClientRects = () => [{ top: 0, bottom: 1000 }] as unknown as DOMRectList
    expect(cachedTimelineLayoutReady(root, () => 1000)).toBe(false)
  })
  test("reports stale heights for explicit repair and never accepts NaN or fallback HTML", () => {
    const { root, markdown } = fixture()
    markdown.dataset.markdownRenderedStage = "full"
    Object.defineProperty(markdown, "offsetHeight", { value: 1000 })
    expect(inspectCachedTimelineLayout(root, () => 800)).toEqual({
      ready: false,
      reason: "height-mismatch",
      repairs: [{ key: "last", height: 1000 }],
    })
    expect(cachedTimelineLayoutReady(root, () => NaN)).toBe(false)
    markdown.dataset.markdownFallback = "true"
    expect(inspectCachedTimelineLayout(root, () => 1000).reason).toBe("markdown-fallback")
  })
  test("only accepts matching measured heights and completed visible Markdown", () => {
    const { root, markdown } = fixture()
    Object.defineProperty(markdown, "offsetHeight", { value: 1000 })
    const heights = (key: string) => (key === "last" ? 1000 : undefined)
    expect(cachedTimelineLayoutReady(root, heights)).toBe(false)
    markdown.dataset.markdownRenderedStage = "full"
    expect(cachedTimelineLayoutReady(root, heights)).toBe(true)
    expect(cachedTimelineLayoutReady(root, () => undefined)).toBe(false)
    expect(cachedTimelineLayoutReady(root, () => 800)).toBe(false)
  })

  test("does not treat an empty mount or a hole above the tail row as a restored viewport", () => {
    expect(cachedTimelineLayoutReady(document.createElement("div"), () => undefined)).toBe(false)
    const { root, row, markdown } = fixture()
    markdown.dataset.markdownRenderedStage = "full"
    Object.defineProperty(markdown, "offsetHeight", { value: 1000 })
    Object.defineProperty(root, "scrollTop", { value: 500 })
    row.getBoundingClientRect = () => ({ top: 200, bottom: 1200 }) as DOMRect
    expect(cachedTimelineLayoutReady(root, () => 1000)).toBe(false)
  })

  test("rejects a virtual-range hole between otherwise cached visible rows", () => {
    const { root, row, markdown } = fixture()
    markdown.dataset.markdownRenderedStage = "full"
    Object.defineProperty(markdown, "offsetHeight", { value: 100 })
    row.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect
    const tail = row.cloneNode(true) as HTMLElement
    Object.defineProperty(tail.firstElementChild!, "offsetHeight", { value: 100 })
    tail.getBoundingClientRect = () => ({ top: 700, bottom: 800 }) as DOMRect
    root.append(tail)
    expect(cachedTimelineLayoutReady(root, () => 100)).toBe(false)
  })
})
