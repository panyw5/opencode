import { afterEach, describe, expect, test } from "bun:test"
import { createQuickAssistantScroll } from "./scroll-controller"

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

function fixture() {
  const root = document.createElement("div")
  const content = document.createElement("div")
  root.append(content)
  document.body.append(root)
  let top = 800
  let height = 1000
  let client = 200
  let writes = 0
  Object.defineProperties(root, {
    scrollTop: {
      get: () => Math.max(0, Math.min(top, height - client)),
      set: (value: number) => {
        writes++
        top = Math.max(0, Math.min(value, height - client))
      },
    },
    scrollHeight: { get: () => height },
    clientHeight: { get: () => client },
  })
  let id = 0
  let time = 0
  const frames = new Map<number, FrameRequestCallback>()
  let resize: (() => void) | undefined
  const scroll = createQuickAssistantScroll({
    request: (callback) => {
      frames.set(++id, callback)
      return id
    },
    cancel: (id) => {
      frames.delete(id)
    },
    observer: (callback) => {
      resize = callback
      return { observe() {}, disconnect() {} }
    },
  })
  scroll.session("a")
  scroll.content(content)
  scroll.bind(root)
  cleanups.push(scroll.dispose)
  const frame = () => {
    time += 16
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(time))
  }
  return {
    root,
    content,
    scroll,
    frames,
    frame,
    settle: () => {
      for (let i = 0; i < 100 && frames.size; i++) frame()
    },
    move: (value: number) => {
      top = value
      scroll.scroll()
    },
    grow: (value: number) => {
      height = value
      resize?.()
    },
    hide: () => {
      client = 0
      scroll.visible(false)
      resize?.()
    },
    show: () => {
      client = 200
      scroll.visible(true)
      resize?.()
    },
    writes: () => writes,
  }
}

describe("quick assistant shared viewport ownership", () => {
  test("uses one follow animation and retargets growing content", () => {
    const f = fixture()
    f.grow(1100)
    f.scroll.layout()
    f.scroll.layout()
    expect(f.frames.size).toBe(1)
    f.frame()
    expect(f.root.scrollTop).toBeGreaterThan(800)
    expect(f.root.scrollTop).toBeLessThan(900)
    f.grow(1200)
    f.settle()
    expect(1000 - f.root.scrollTop).toBeLessThanOrEqual(1)
  })

  test("upward intent cancels a queued write before any movement", () => {
    const f = fixture()
    f.grow(1200)
    f.scroll.input(-0.5)
    const writes = f.writes()
    f.frame()
    expect(f.writes()).toBe(writes)
    expect(f.scroll.reading()).toBe(true)
    f.move(800)
    f.move(799.5)
    expect(f.scroll.reading()).toBe(true)
  })

  test("only real downward movement at the physical bottom resumes", () => {
    const f = fixture()
    f.scroll.input(-1)
    f.move(780)
    f.move(800)
    expect(f.scroll.reading()).toBe(true)
    f.scroll.input(1)
    f.move(780)
    f.move(800)
    expect(f.scroll.following()).toBe(true)
  })

  test("programmatic follow events and growth do not become user takeover", () => {
    const f = fixture()
    f.grow(1300)
    f.frame()
    f.scroll.scroll()
    f.grow(1400)
    f.scroll.scroll()
    expect(f.scroll.following()).toBe(true)
    f.settle()
    expect(f.scroll.following()).toBe(true)
  })

  test("a layout clamp cannot resume reading", () => {
    const f = fixture()
    f.scroll.input(-1)
    f.move(700)
    f.grow(600)
    expect(f.scroll.reading()).toBe(true)
    expect(f.frames.size).toBe(0)
  })

  test("controlled keyboard or thumb movement records user displacement once", () => {
    const f = fixture()
    f.scroll.position(600, -1)
    expect(f.scroll.reading()).toBe(true)
    f.scroll.scroll()
    expect(f.scroll.reading()).toBe(true)
    f.scroll.position(800, 1)
    expect(f.scroll.following()).toBe(true)
  })

  test("hidden viewports do not write and live views resume on reveal", () => {
    const f = fixture()
    f.grow(1200)
    f.hide()
    const writes = f.writes()
    f.frame()
    f.grow(1400)
    expect(f.writes()).toBe(writes)
    f.show()
    f.settle()
    expect(1200 - f.root.scrollTop).toBeLessThanOrEqual(1)
  })

  test("reading intent survives hiding and showing", () => {
    const f = fixture()
    f.scroll.input(-1)
    f.move(600)
    f.hide()
    f.grow(1400)
    f.show()
    expect(f.scroll.reading()).toBe(true)
    expect(f.root.scrollTop).toBe(600)
  })

  test("reading compensation preserves a semantic block through hide and remount", () => {
    const f = fixture()
    let blockTop = 650
    const message = document.createElement("div")
    message.dataset.messageId = "reading"
    const block = document.createElement("p")
    block.dataset.sourceLine = "1"
    block.textContent = "reading marker"
    message.append(block)
    f.content.append(message)
    f.root.getBoundingClientRect = () => new DOMRect(0, 0, 500, 200)
    message.getBoundingClientRect = () => new DOMRect(0, 0, 500, 2000)
    block.getBoundingClientRect = () => new DOMRect(0, blockTop - f.root.scrollTop, 500, 200)
    f.scroll.input(-1)
    f.move(600)
    const commit = f.scroll.beforeUpdate(f.content)
    blockTop += 100
    commit()
    expect(f.root.scrollTop).toBe(700)
    f.hide()
    blockTop += 50
    f.show()
    expect(f.root.scrollTop).toBe(750)
    f.grow(1400)
    f.scroll.input(1)
    blockTop += 40
    f.move(780)
    expect(f.root.scrollTop).toBe(820)
    f.scroll.bind(undefined)
    f.scroll.bind(f.root)
    expect(f.scroll.reading()).toBe(true)
    expect(f.root.scrollTop).toBe(820)
  })

  test("nested scrollables consume their own wheel before outer takeover", () => {
    const f = fixture()
    f.content.dataset.scrollable = ""
    Object.defineProperties(f.content, {
      scrollTop: { value: 100 },
      scrollHeight: { value: 1000 },
      clientHeight: { value: 200 },
    })
    f.scroll.input(-1, f.content)
    expect(f.scroll.following()).toBe(true)
    f.scroll.input(-200, f.content)
    expect(f.scroll.reading()).toBe(true)
  })

  test("old DOM commits cannot write after user takeover or root rebind", () => {
    const f = fixture()
    const commit = f.scroll.beforeUpdate(f.content)
    f.scroll.input(-1)
    f.grow(1200)
    const writes = f.writes()
    commit()
    f.frame()
    expect(f.writes()).toBe(writes)
    const old = f.scroll.beforeUpdate(f.content)
    f.scroll.bind(undefined)
    f.scroll.bind(f.root)
    old()
    expect(f.writes()).toBe(writes)
  })

  test("session replacement resets intent and invalidates old callbacks", () => {
    const f = fixture()
    f.scroll.takeover()
    const commit = f.scroll.beforeUpdate(f.content)
    f.scroll.session("b")
    f.grow(1200)
    expect(f.scroll.following()).toBe(true)
    const writes = f.writes()
    commit()
    expect(f.writes()).toBe(writes)
    f.settle()
    expect(1000 - f.root.scrollTop).toBeLessThanOrEqual(1)
  })

  test("cleanup cancels queued frames and stale observer callbacks", () => {
    const f = fixture()
    f.grow(1200)
    f.scroll.dispose()
    const writes = f.writes()
    f.frame()
    f.grow(1400)
    expect(f.writes()).toBe(writes)
    expect(f.frames.size).toBe(0)
  })
})
