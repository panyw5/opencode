import { describe, expect, test } from "bun:test"
import { initialTimelineLayoutReady } from "./initial-timeline-layout"

function fixture() {
  const root = document.createElement("div")
  root.innerHTML = '<div data-timeline-key="last"><div data-component="markdown" data-markdown-stage="full"></div></div>'
  const row = root.firstElementChild as HTMLElement
  const markdown = row.firstElementChild as HTMLElement
  root.getBoundingClientRect = () => ({ top: 0, bottom: 800 }) as DOMRect
  row.getBoundingClientRect = () => ({ top: 0, bottom: 1000 }) as DOMRect
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
})
