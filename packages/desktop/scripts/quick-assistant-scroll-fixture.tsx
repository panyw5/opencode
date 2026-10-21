import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { MarkedProvider } from "../../ui/src/context/marked"
import { LanguageProvider } from "../../app/src/context/language"
import { PlatformProvider, type Platform } from "../../app/src/context/platform"
import { QuickAssistantMessages } from "../../app/src/components/quick-assistant/messages"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

function plainNodes(block: HTMLElement) {
  const nodes: Text[] = []
  const excluded =
    ".katex,[data-math-style],[data-opencode-math-style],[data-opencode-math-tex],[data-component='markdown-math'],button,[aria-hidden='true'],script,style"
  if (block.matches(excluded)) return nodes
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE)
        return (node as Element).matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text)
  }
  return nodes
}

function glyphAt(block: HTMLElement, index: number) {
  const nodes = plainNodes(block)
  for (const node of nodes) {
    if (index < node.length) {
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      return range.getBoundingClientRect().top
    }
    index -= node.length
  }
}

function captureGlyph(block: HTMLElement, viewport: HTMLElement, nearestText = false) {
  const rect = block.getBoundingClientRect()
  const box = viewport.getBoundingClientRect()
  const y = box.top + viewport.clientTop + Math.min(80, viewport.clientHeight / 3)
  if (y < rect.top || y > rect.bottom) return
  const nodes = plainNodes(block)
  for (const dx of [Math.min(24, rect.width * 0.15), rect.width * 0.35, rect.width * 0.65]) {
    const x = Math.max(box.left + 1, Math.min(box.right - 1, rect.left + dx))
    const caret = document.caretRangeFromPoint(x, y)
    if (!caret || !nodes.includes(caret.startContainer as Text)) continue
    const node = caret.startContainer as Text
    if (!node.length) continue
    const selected = document.createRange()
    selected.setStart(node, Math.min(caret.startOffset, node.length - 1))
    selected.setEnd(node, Math.min(caret.startOffset, node.length - 1) + 1)
    const selectedBox = selected.getBoundingClientRect()
    if (
      selectedBox.width <= 0 ||
      selectedBox.height <= 0 ||
      (!nearestText && (y < selectedBox.top - 3 || y > selectedBox.bottom + 3))
    )
      continue
    const index =
      nodes.slice(0, nodes.indexOf(node)).reduce((count, node) => count + node.length, 0) +
      Math.min(caret.startOffset, node.length - 1)
    const top = glyphAt(block, index)
    if (top !== undefined)
      return { text: nodes.map((node) => node.data).join(""), index, offset: top - box.top - viewport.clientTop }
  }
}

export function trackQuickAssistantScrollFixture(options: { wheel?: boolean; nearestText?: boolean } = {}) {
  const host = document.querySelector<HTMLElement>("[data-quick-scroll-fixture]")!
  const viewport = host.querySelector<HTMLElement>('[data-component="quick-assistant-viewport"]')!
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!
  let programmatic = 0
  let writes = 0
  let stageChanges = 0
  let heightChanges = 0
  let previousHeight = viewport.scrollHeight
  let running = true
  let frame = 0
  let previous:
    | {
        message: string
        line: string
        occurrence: number
        offset: number
        top: number
        programmatic: number
        glyph?: ReturnType<typeof captureGlyph>
      }
    | undefined
  let pending: typeof previous
  let currentSample: number | undefined
  const samples: Array<{ residual: number; message: string; line: string; scrollTop: number; glyph: boolean }> = []
  const longTasks: number[] = []
  const performanceObserver = new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) longTasks.push(entry.duration)
  })
  performanceObserver.observe({ type: "longtask" })
  const candidates = () => [...host.querySelectorAll<HTMLElement>("[data-source-line]")]
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => descriptor.get!.call(viewport),
    set: (value: number) => {
      const before = descriptor.get!.call(viewport) as number
      descriptor.set!.call(viewport, value)
      const after = descriptor.get!.call(viewport) as number
      programmatic += after - before
      writes++
    },
  })
  const stages = new MutationObserver((records) => {
    stageChanges += records.length
  })
  stages.observe(host, { subtree: true, attributes: true, attributeFilter: ["data-markdown-rendered-stage"] })
  const sample = () => {
    if (!running) return
    const box = viewport.getBoundingClientRect()
    if (viewport.scrollHeight !== previousHeight) heightChanges++
    previousHeight = viewport.scrollHeight
    const blocks = candidates()
    if (previous) {
      const matching = blocks.filter(
        (block) =>
          block.dataset.sourceLine === previous!.line &&
          block.closest<HTMLElement>("[data-message-id]")?.dataset.messageId === previous!.message,
      )
      const block = matching[previous.occurrence]
      if (block) {
        const nativeDelta = options.wheel
          ? viewport.scrollTop - previous.top - (programmatic - previous.programmatic)
          : 0
        const glyph = previous.glyph
        const sameText =
          glyph &&
          plainNodes(block)
            .map((node) => node.data)
            .join("") === glyph.text
        const glyphTop = sameText ? glyphAt(block, glyph.index) : undefined
        const residual =
          glyphTop !== undefined && glyph
            ? glyphTop - box.top - viewport.clientTop - glyph.offset + nativeDelta
            : block.getBoundingClientRect().top - box.top - previous.offset + nativeDelta
        const value = {
          residual,
          message: previous.message,
          line: previous.line,
          scrollTop: viewport.scrollTop,
          glyph: glyphTop !== undefined,
        }
        if (currentSample === undefined) {
          currentSample = samples.length
          samples.push(value)
        } else samples[currentSample] = value
      }
    }
    const readingLine = box.top + viewport.clientTop + Math.min(80, viewport.clientHeight / 3)
    const block = blocks.find((block) => {
      const rect = block.getBoundingClientRect()
      return rect.bottom > readingLine && rect.top < box.bottom && rect.height > 0
    })
    const message = block?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
    const line = block?.dataset.sourceLine
    pending =
      block && message && line
        ? {
            message,
            line,
            occurrence: blocks
              .filter(
                (candidate) =>
                  candidate.dataset.sourceLine === line &&
                  candidate.closest<HTMLElement>("[data-message-id]")?.dataset.messageId === message,
              )
              .indexOf(block),
            offset: block.getBoundingClientRect().top - box.top,
            top: viewport.scrollTop,
            programmatic,
            glyph: captureGlyph(block, viewport, options.nearestText),
          }
        : undefined
  }
  // Keep the prior painted-frame baseline frozen while RO replaces this frame's provisional sample.
  const tick = () => {
    previous = pending
    currentSample = undefined
    sample()
    frame = requestAnimationFrame(tick)
  }
  sample()
  previous = pending
  const resized = new ResizeObserver(() => sample())
  resized.observe(viewport)
  if (viewport.firstElementChild) resized.observe(viewport.firstElementChild)
  frame = requestAnimationFrame(tick)
  return () => {
    running = false
    cancelAnimationFrame(frame)
    resized.disconnect()
    stages.disconnect()
    for (const entry of performanceObserver.takeRecords()) longTasks.push(entry.duration)
    performanceObserver.disconnect()
    delete (viewport as Partial<HTMLElement>).scrollTop
    return {
      samples,
      writes,
      stageChanges,
      heightChanges,
      glyphSamples: samples.filter((sample) => sample.glyph).length,
      longTasks,
      maxResidual: Math.max(0, ...samples.map((sample) => Math.abs(sample.residual))),
    }
  }
}

function response(index: number, tall = false) {
  const vector = tall
    ? String.raw`p_i=\frac{\displaystyle\sum_{k=1}^{n}\frac{e_k}{k}}{\sqrt{\frac{1}{2}}},\qquad q_i=\frac{\displaystyle\sum_{k=1}^{n}\frac{e_k}{k+1}}{\sqrt{\frac{1}{2}}}`
    : String.raw`p_i=\frac{e_{2i-1}+ie_{2i}}{\sqrt{2}},\qquad q_i=\frac{e_{2i-1}-ie_{2i}}{\sqrt{2}}`
  return Array.from(
    { length: 10 },
    (_, section) => `## Basis ${index}.${section}

The paired vectors satisfy the following relation. Read marker ${index}.${section}.

$$
${vector}
$$

$$
\\boxed{(p_i,p_j)=0,\\qquad(q_i,q_j)=0,\\qquad(p_i,q_j)=\\delta_{ij}}
$$

This is an algebraic construction in a complex vector space. The reading marker is stable while formulas elsewhere change height.

`,
  ).join("")
}

function paragraph() {
  return Array.from(
    { length: 160 },
    (_, part) =>
      `INLINE_MARKER_${part} The invariant pairs remain algebraic while this paragraph wraps to many screenfuls. $p_i^2+q_i^2=0$ `,
  ).join("")
}

export function mountQuickAssistantScrollFixture(options: { width?: number; paragraph?: number } = {}) {
  const host = document.createElement("div")
  const originalLocale = document.documentElement.lang
  const originalLocaleCookie = document.cookie.split("; ").find((value) => value.startsWith("oc_locale="))
  host.dataset.quickScrollFixture = ""
  host.style.cssText =
    "position:fixed;top:80px;right:40px;bottom:40px;z-index:9999;background:var(--background-base);display:flex;flex-direction:column"
  host.style.width = `${Math.min(options.width ?? 1040, innerWidth - 80)}px`
  document.body.append(host)
  const list = Array.from({ length: 12 }, (_, index) => ({
    id: `scroll_fixture_${index}`,
    role: index % 2 ? "assistant" : "user",
    time: { created: index + 1, completed: index + 2 },
  })) as Message[]
  const [state, setState] = createStore({
    busy: false,
    parts: Object.fromEntries(
      list.map((message, index) => [
        message.id,
        [
          {
            id: `part_${index}`,
            sessionID: "ses_scroll_fixture",
            messageID: message.id,
            type: "text",
            text:
              message.role === "user"
                ? index === 6
                  ? `<current-opencode-session>\ndirectory: /private/tmp\n${"Attached session context paragraph.\n".repeat(20)}</current-opencode-session>\n\nQuestion ${index}: explain the isotropic basis.`
                  : `Question ${index}: explain the isotropic basis.`
                : options.paragraph === index
                  ? paragraph()
                  : response(index),
          },
        ] as Array<Extract<Part, { type: "text" }>>,
      ]),
    ),
  })
  const platform: Platform = {
    platform: "desktop",
    openLink: () => {},
    restart: async () => {},
    back: () => {},
    forward: () => {},
    notify: async () => {},
    storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
  }
  const dispose = render(
    () => (
      <PlatformProvider value={platform}>
        <LanguageProvider>
          <MarkedProvider>
            <QuickAssistantMessages list={list} parts={state.parts} busy={state.busy} waiting={true} />
          </MarkedProvider>
        </LanguageProvider>
      </PlatformProvider>
    ),
    host,
  )
  console.debug(`[quick-scroll-fixture] mounted width=${host.style.width} messages=${list.length}`)
  return {
    resize(width: number) {
      host.style.width = `${Math.min(width, innerWidth - 80)}px`
      console.debug(`[quick-scroll-fixture] resize width=${host.style.width}`)
    },
    formula(index: number, tall: boolean) {
      if (index % 2 === 0 || !list[index]) throw new Error("Formula fixture requires an assistant message index")
      setState("parts", list[index].id, 0, "text", response(index, tall))
      console.debug(`[quick-scroll-fixture] formula index=${index} tall=${tall}`)
    },
    append(index: number) {
      const message = list[index]
      if (!message) throw new Error("Unknown fixture message")
      setState(
        "parts",
        message.id,
        0,
        "text",
        (text) => `${text}\n\nAppended response tail.\n\n$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$`,
      )
      console.debug(`[quick-scroll-fixture] appended index=${index}`)
    },
    busy(value: boolean) {
      setState("busy", value)
    },
    font(size: number) {
      for (const block of host.querySelectorAll<HTMLElement>(
        ".quick-assistant-markdown,.quick-assistant-markdown [data-component=markdown],.quick-assistant-markdown p",
      )) {
        block.style.fontSize = `${size}px`
        block.style.lineHeight = `${(size * 28) / 15}px`
      }
      console.debug(`[quick-scroll-fixture] font size=${size}`)
    },
    paragraph(index: number) {
      const message = list[index]
      if (!message || index % 2 === 0) throw new Error("Paragraph fixture requires an assistant message")
      const text = paragraph()
      setState("parts", message.id, 0, "text", text)
      console.debug(`[quick-scroll-fixture] paragraph index=${index} chars=${text.length}`)
    },
    dispose() {
      dispose()
      host.remove()
      document.documentElement.lang = originalLocale
      document.cookie = originalLocaleCookie
        ? `${originalLocaleCookie}; Path=/; Max-Age=31536000; SameSite=Lax`
        : "oc_locale=; Path=/; Max-Age=0; SameSite=Lax"
      console.debug("[quick-scroll-fixture] disposed and locale restored")
    },
  }
}
