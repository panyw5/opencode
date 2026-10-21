type BlockKey = { messageID: string; sourceLine?: string; occurrence: number }
type TextAnchor = { text: string; character: number; offset: number }

export type QuickAssistantReadingSnapshot = {
  viewport: HTMLElement
  generation: number
  following: boolean
  userDisplacement: number
  key?: BlockKey
  offset?: number
  height?: number
  text?: TextAnchor
}

type Options = {
  viewport: () => HTMLElement | undefined
  following: () => boolean
  written: (viewport: HTMLElement) => void
  log?: (message: string) => void
  tolerance?: number
}

const messageSelector = "[data-message-id]"
const blockSelector = "[data-source-line]"
const excludedTextSelector =
  '.katex,[data-opencode-math-tex],[data-opencode-math-style],[data-math-style],[data-component="markdown-math"],button,[aria-hidden="true"],script,style'

function plainText(block: HTMLElement) {
  const nodes: Text[] = []
  let text = ""
  if (block.closest(excludedTextSelector)) return { nodes, text }
  const walker = block.ownerDocument.createTreeWalker(block, 5, {
    acceptNode(node) {
      // Reject whole KaTeX/control subtrees rather than visiting every duplicated glyph.
      if (node.nodeType === 1) return (node as Element).matches(excludedTextSelector) ? 2 : 3
      return 1
    },
  })
  let node: Node | null
  while ((node = walker.nextNode())) {
    nodes.push(node as Text)
    text += node.textContent ?? ""
  }
  return { nodes, text }
}

function characterBox(node: Text, offset: number) {
  if (offset < 0 || offset >= node.length) return
  try {
    const range = node.ownerDocument.createRange()
    range.setStart(node, offset)
    range.setEnd(node, offset + 1)
    if (typeof range.getBoundingClientRect !== "function") return
    const rect = range.getBoundingClientRect()
    if (rect.height > 0 && rect.width > 0) return rect
  } catch {
    // Selection geometry is optional; disconnected/replaced text falls back to its source block.
  }
}

function captureText(block: HTMLElement, viewport: HTMLElement, line: number, viewportTop: number) {
  const doc = block.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (!doc.caretRangeFromPoint && !doc.caretPositionFromPoint) return
  const { nodes, text } = plainText(block)
  if (!text || nodes.length === 0) return
  const box = block.getBoundingClientRect()
  const viewportBox = viewport.getBoundingClientRect()
  if (line < box.top || line > box.bottom) return
  const style = doc.defaultView?.getComputedStyle(block)
  const fontSize = Number.parseFloat(style?.fontSize ?? "") || 16
  const lineHeight = Number.parseFloat(style?.lineHeight ?? "") || fontSize * 1.5
  const nearby = Math.min(64, Math.max(12, lineHeight))
  const viewportBottom = viewportTop + viewport.clientHeight
  let best: { anchor: TextAnchor; distance: number } | undefined
  const probe = (y: number) => {
    for (const inset of [Math.min(24, box.width * 0.15), box.width * 0.35, box.width * 0.65]) {
      const x = Math.max(viewportBox.left + 1, Math.min(viewportBox.right - 1, box.left + inset))
      const range = doc.caretRangeFromPoint?.(x, y)
      const caret = range
        ? { offsetNode: range.startContainer, offset: range.startOffset }
        : doc.caretPositionFromPoint?.(x, y)
      if (!caret || caret.offsetNode.nodeType !== 3) continue
      const index = nodes.indexOf(caret.offsetNode as Text)
      if (index < 0) continue
      const node = nodes[index]
      const offset = Math.min(caret.offset, node.length - 1)
      const rect = characterBox(node, offset)
      if (!rect || rect.bottom <= viewportTop || rect.top >= viewportBottom) continue
      const distance = Math.max(rect.top - line, line - rect.bottom, 0)
      if (distance > nearby || (best && distance >= best.distance)) continue
      const character = nodes.slice(0, index).reduce((sum, item) => sum + item.length, 0) + offset
      best = { anchor: { text, character, offset: rect.top - viewportTop }, distance }
      if (distance === 0) return
    }
  }
  probe(line)
  // A reading line may fall between glyph boxes, or all x probes may land in inline math.
  if (!best) {
    for (const direction of [-1, 1]) {
      const y = Math.max(
        viewportTop + 1,
        box.top + 1,
        Math.min(viewportBottom - 1, box.bottom - 1, line + (direction * nearby) / 2),
      )
      probe(y)
    }
  }
  return best?.anchor
}

function resolveText(block: HTMLElement, captured: TextAnchor) {
  const { nodes, text } = plainText(block)
  // Do not pin a stale character after the actual source text was edited or streamed.
  if (text !== captured.text) return
  let offset = captured.character
  for (const node of nodes) {
    if (offset < node.length) return characterBox(node, offset)
    offset -= node.length
  }
}

function firstAtLine(elements: HTMLElement[], line: number) {
  let left = 0
  let right = elements.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (elements[middle].getBoundingClientRect().bottom <= line) left = middle + 1
    else right = middle
  }
  return Math.min(left, elements.length - 1)
}

function captureBlock(viewport: HTMLElement) {
  const box = viewport.getBoundingClientRect()
  const top = box.top + viewport.clientTop
  const bottom = top + viewport.clientHeight
  const line = top + Math.min(80, viewport.clientHeight / 3)
  const messages = Array.from(viewport.querySelectorAll<HTMLElement>(messageSelector))
  const index = firstAtLine(messages, line)
  if (index < 0) return
  const message = messages[index]
  const messageBox = message.getBoundingClientRect()
  if (messageBox.bottom <= top || messageBox.top >= bottom) return

  const blocks = Array.from(message.querySelectorAll<HTMLElement>(blockSelector))
  const blockIndex = firstAtLine(blocks, line)
  const block = blockIndex >= 0 ? blocks[blockIndex] : message
  const rect = block.getBoundingClientRect()
  if (rect.height <= 0 || rect.bottom <= top || rect.top >= bottom) return
  const sourceLine = block === message ? undefined : block.dataset.sourceLine
  const occurrence =
    sourceLine === undefined
      ? 0
      : blocks.slice(0, blockIndex).filter((item) => item.dataset.sourceLine === sourceLine).length
  return {
    key: { messageID: message.dataset.messageId!, sourceLine, occurrence },
    offset: rect.top - top,
    height: rect.height,
    text: captureText(block, viewport, line, top),
  }
}

function findBlock(viewport: HTMLElement, key: BlockKey) {
  const message = Array.from(viewport.querySelectorAll<HTMLElement>(messageSelector)).find(
    (element) => element.dataset.messageId === key.messageID,
  )
  if (!message) return
  if (key.sourceLine === undefined) return message
  return Array.from(message.querySelectorAll<HTMLElement>(blockSelector)).filter(
    (element) => element.dataset.sourceLine === key.sourceLine,
  )[key.occurrence]
}

export function createQuickAssistantReadingAnchor(options: Options) {
  const tolerance = options.tolerance ?? 1
  const log = options.log ?? ((message: string) => console.debug(message))
  let generation = 0
  let userDisplacement = 0
  let previousTop = options.viewport()?.scrollTop ?? 0
  let previousMaximum = Math.max(0, (options.viewport()?.scrollHeight ?? 0) - (options.viewport()?.clientHeight ?? 0))
  let pendingTop: number | undefined

  const snapshot = (): QuickAssistantReadingSnapshot | undefined => {
    const viewport = options.viewport()
    if (!viewport?.isConnected || viewport.clientHeight <= 0) return
    const following = options.following()
    const block = following ? undefined : captureBlock(viewport)
    if (!following && !block) return
    // Capture immediately before a commit, not at an earlier render-stage notification.
    previousTop = viewport.scrollTop
    return { viewport, generation, following, userDisplacement, ...block }
  }

  const write = (viewport: HTMLElement, target: number, reason: string) => {
    const before = viewport.scrollTop
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollTop = Math.min(maximum, Math.max(0, target))
    const actual = viewport.scrollTop
    pendingTop = actual
    previousTop = actual
    previousMaximum = maximum
    options.written(viewport)
    const delta = actual - before
    if (Math.abs(delta) > tolerance) {
      log(`[quick-assistant:anchor] restore reason=${reason} before=${before} after=${actual} delta=${delta}`)
    }
    return delta
  }

  const restoreSnapshot = (captured: QuickAssistantReadingSnapshot | undefined) => {
    const viewport = options.viewport()
    if (!captured || captured.generation !== generation || captured.viewport !== viewport || !viewport?.isConnected) {
      return 0
    }
    if (captured.following) {
      if (!options.following()) return 0
      return write(viewport, viewport.scrollHeight - viewport.clientHeight, "bottom")
    }
    if (options.following() || !captured.key || captured.offset === undefined) return 0
    const block = findBlock(viewport, captured.key)
    if (!block?.isConnected) {
      log(`[quick-assistant:anchor] restore skipped reason=missing-block message=${captured.key.messageID}`)
      return 0
    }
    const expected = captured.offset - (userDisplacement - captured.userDisplacement)
    // A delayed resize must not pull the reader back to an already passed block.
    if (captured.height !== undefined && expected < -captured.height) return 0
    const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
    const text = captured.text && resolveText(block, captured.text)
    const actual = (text ?? block.getBoundingClientRect()).top - viewportTop
    const desired =
      text && captured.text ? captured.text.offset - (userDisplacement - captured.userDisplacement) : expected
    const correction = actual - desired
    if (Math.abs(correction) <= tolerance) return 0
    return write(viewport, viewport.scrollTop + correction, text ? "reading-character" : "reading-block")
  }

  return {
    snapshot,
    restoreSnapshot,
    beforeUpdate(container: HTMLElement) {
      const viewport = options.viewport()
      const captured = viewport?.contains(container) ? snapshot() : undefined
      if (captured) {
        log(
          `[quick-assistant:anchor] capture mode=${captured.following ? "bottom" : "reading"} message=${captured.key?.messageID ?? "none"} line=${captured.key?.sourceLine ?? "none"} offset=${captured.offset ?? 0} character=${captured.text?.character ?? "none"}`,
        )
      }
      let restored = false
      return () => {
        if (restored) return
        restored = true
        restoreSnapshot(captured)
      }
    },
    scrolled(viewport: HTMLElement) {
      if (viewport !== options.viewport()) return false
      const top = viewport.scrollTop
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      const clamped = maximum < previousMaximum && previousTop > maximum
      const baseline = clamped ? maximum : previousTop
      const acknowledged =
        (pendingTop !== undefined && Math.abs(top - Math.min(pendingTop, maximum)) <= tolerance) ||
        (clamped && Math.abs(top - maximum) <= tolerance)
      pendingTop = undefined
      if (!acknowledged) userDisplacement += top - baseline
      previousTop = top
      previousMaximum = maximum
      return acknowledged
    },
    reset() {
      generation++
      userDisplacement = 0
      pendingTop = undefined
      previousTop = options.viewport()?.scrollTop ?? 0
      previousMaximum = Math.max(0, (options.viewport()?.scrollHeight ?? 0) - (options.viewport()?.clientHeight ?? 0))
    },
  }
}
