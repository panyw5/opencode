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
  const message = document.createElement("div")
  message.dataset.messageId = "reading"
  const block = document.createElement("p")
  block.dataset.sourceLine = "1"
  block.textContent = "reading marker"
  message.append(block)
  content.append(message)
  root.append(content)
  document.body.append(root)
  let top = 800
  let height = 1000
  let blockTop = 0
  let client = 200
  let writes = 0
  root.getBoundingClientRect = () => new DOMRect(0, 0, 500, client)
  content.getBoundingClientRect = () => new DOMRect(0, -root.scrollTop, 500, height)
  message.getBoundingClientRect = () => new DOMRect(0, blockTop - root.scrollTop, 500, height - blockTop)
  block.getBoundingClientRect = () => message.getBoundingClientRect()
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
    native: (value: number) => {
      top = value
    },
    move: (value: number) => {
      top = value
      scroll.scroll()
    },
    shiftBlock: (value: number) => {
      blockTop += value
    },
    observer: () => resize!,
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

  test("a shrink does not swallow native motion when the viewport was not clamped", () => {
    const f = fixture()
    f.scroll.position(700, -1)
    f.scroll.endInput()
    f.native(500)
    f.grow(800)
    expect(f.root.scrollTop).toBe(500)
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

  test("native upward motion after endInput stays at the reader's new position", () => {
    const f = fixture()
    f.scroll.position(600, -1)
    f.scroll.endInput()
    const writes = f.writes()

    f.move(550)
    f.scroll.scroll()
    f.scroll.layout()

    expect(f.scroll.reading()).toBe(true)
    expect(f.root.scrollTop).toBe(550)
    expect(f.writes()).toBe(writes)
    expect(f.frames.size).toBe(0)
  })

  for (const first of ["commit", "resize"] as const) {
    test(`${first} compensates layout without cancelling native motion during a reading transaction`, () => {
      const f = fixture()
      f.scroll.position(600, -1)
      f.scroll.endInput()
      const commit = f.scroll.beforeUpdate(f.content)
      const writes = f.writes()

      // The browser moves before its scroll event is delivered; layout also grows above the reading block.
      f.native(550)
      f.shiftBlock(100)
      if (first === "commit") {
        commit()
        f.grow(1100)
      } else {
        f.grow(1100)
        commit()
      }
      expect(f.root.scrollTop).toBe(650)
      expect(f.writes()).toBe(writes + 1)

      // A coalesced native event, duplicate commit, and duplicate RO must not compensate a second time.
      f.scroll.scroll()
      commit()
      f.grow(1100)
      expect(f.root.scrollTop).toBe(650)
      expect(f.writes()).toBe(writes + 1)
      expect(f.scroll.reading()).toBe(true)
      expect(f.frames.size).toBe(0)
    })
  }

  test("a DOM update preserves the baseline of an earlier unobserved layout change", () => {
    const f = fixture()
    f.scroll.position(600, -1)
    f.scroll.endInput()
    f.shiftBlock(100)
    Object.defineProperty(f.content, "offsetHeight", { value: 1100, configurable: true })
    const update = f.scroll.beforeUpdate(f.content)
    update()
    expect(f.root.scrollTop).toBe(700)
    f.grow(1100)
    expect(f.root.scrollTop).toBe(700)
  })

  for (const boundary of ["hide", "rebind"] as const) {
    test(`${boundary} preserves a reading baseline while a DOM transaction is pending`, () => {
      const f = fixture()
      f.scroll.position(600, -1)
      f.scroll.endInput()
      const commit = f.scroll.beforeUpdate(f.content)
      f.shiftBlock(100)
      if (boundary === "hide") {
        f.hide()
        f.show()
      } else {
        f.scroll.bind(undefined)
        f.scroll.bind(f.root)
      }
      commit()
      expect(f.root.scrollTop).toBe(700)
      expect(f.scroll.reading()).toBe(true)
    })
  }

  test("remount waits for the saved source block before replacing its baseline", () => {
    const f = fixture()
    f.scroll.position(600, -1)
    f.scroll.endInput()
    f.scroll.bind(undefined)
    const message = f.content.firstElementChild!
    message.remove()
    f.native(0)
    f.scroll.bind(f.root)
    expect(f.root.scrollTop).toBe(0)
    f.content.append(message)
    f.scroll.layout()
    expect(f.root.scrollTop).toBe(600)
    expect(f.scroll.reading()).toBe(true)
  })

  test("reversed native input coalesced with a layout write is counted once", () => {
    const f = fixture()
    f.scroll.position(600, -1)
    f.scroll.input(1)
    const commit = f.scroll.beforeUpdate(f.content)
    const writes = f.writes()
    f.shiftBlock(100)
    commit()
    expect(f.root.scrollTop).toBe(700)
    expect(f.writes()).toBe(writes + 1)

    // The pending +100 programmatic scroll and a -40 reversal arrive as one net +60 native event.
    f.native(660)
    f.scroll.input(-1)
    f.scroll.scroll()
    f.scroll.endInput()
    commit()
    f.grow(1100)
    expect(f.root.scrollTop).toBe(660)
    expect(f.writes()).toBe(writes + 1)

    // Another layout change must retain the already-accounted reversal rather than applying it twice.
    f.shiftBlock(30)
    f.grow(1130)
    f.scroll.scroll()
    commit()
    expect(f.root.scrollTop).toBe(690)
    expect(f.writes()).toBe(writes + 2)
    expect(f.scroll.reading()).toBe(true)
  })

  for (const boundary of ["session", "root"] as const) {
    test(`old reading transactions and observers cannot write across ${boundary} replacement`, () => {
      const f = fixture()
      f.scroll.position(600, -1)
      f.scroll.endInput()
      const commit = f.scroll.beforeUpdate(f.content)
      const resize = f.observer()
      let reboundWrites = 0
      if (boundary === "session") {
        f.scroll.session("b")
        f.scroll.takeover()
      } else {
        f.scroll.bind(undefined)
        const root = document.createElement("div")
        document.body.append(root)
        root.append(f.content)
        let top = 600
        Object.defineProperties(root, {
          scrollTop: {
            get: () => top,
            set: (value: number) => {
              top = value
              reboundWrites++
            },
          },
          scrollHeight: { get: () => 1000 },
          clientHeight: { get: () => 200 },
        })
        root.getBoundingClientRect = () => new DOMRect(0, 0, 500, 200)
        f.scroll.bind(root)
      }
      const writes = f.writes()
      const rebound = reboundWrites
      f.shiftBlock(100)
      commit()
      resize()
      expect(f.writes()).toBe(writes)
      expect(reboundWrites).toBe(rebound)
      expect(f.frames.size).toBe(0)
    })
  }

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
    f.shiftBlock(650)
    f.scroll.input(-1)
    f.move(600)
    const commit = f.scroll.beforeUpdate(f.content)
    f.shiftBlock(100)
    commit()
    expect(f.root.scrollTop).toBe(700)
    f.hide()
    f.shiftBlock(50)
    f.show()
    expect(f.root.scrollTop).toBe(750)
    f.grow(1400)
    f.scroll.input(1)
    const update = f.scroll.beforeUpdate(f.content)
    f.shiftBlock(40)
    f.move(780)
    expect(f.root.scrollTop).toBe(780)
    update()
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
