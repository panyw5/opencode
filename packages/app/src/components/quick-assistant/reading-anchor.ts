type BlockKey = { messageID: string; sourceLine?: string; occurrence: number }
type TextAnchor = { text: string; character: number; offset: number }

export type QuickAssistantReadingSnapshot = {
  userDisplacement: number
  key: BlockKey
  offset: number
  height: number
  text?: TextAnchor
}

type Options = {
  viewport: () => HTMLElement | undefined
  reading: () => boolean
  userDisplacement: () => number
  write: (viewport: HTMLElement, target: number) => number
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
  const log = options.log ?? (() => {})

  const snapshot = (): QuickAssistantReadingSnapshot | undefined => {
    const viewport = options.viewport()
    if (!options.reading() || !viewport?.isConnected || viewport.clientHeight <= 0) return
    const block = captureBlock(viewport)
    if (!block || !Number.isFinite(block.offset) || !Number.isFinite(block.height)) return
    return { userDisplacement: options.userDisplacement(), ...block }
  }

  const restoreSnapshot = (captured: QuickAssistantReadingSnapshot | undefined) => {
    const viewport = options.viewport()
    if (!captured || !options.reading() || !viewport?.isConnected || viewport.clientHeight <= 0) return 0
    const block = findBlock(viewport, captured.key)
    if (!block?.isConnected) {
      log(`[quick-assistant:anchor] restore skipped reason=missing-block message=${captured.key.messageID}`)
      return 0
    }
    const displacement = options.userDisplacement() - captured.userDisplacement
    const expected = captured.offset - displacement
    // A delayed resize must not pull the reader back to an already passed block.
    if (expected < -captured.height) return 0
    const rect = block.getBoundingClientRect()
    if (rect.height <= 0) return 0
    const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
    const text = captured.text && resolveText(block, captured.text)
    const actual = (text ?? rect).top - viewportTop
    const desired = text && captured.text ? captured.text.offset - displacement : expected
    const correction = actual - desired
    if (!Number.isFinite(correction) || Math.abs(correction) <= tolerance) return 0
    const before = viewport.scrollTop
    const delta = options.write(viewport, before + correction)
    if (Math.abs(delta) > tolerance) {
      log(
        `[quick-assistant:anchor] restore reason=${text ? "reading-character" : "reading-block"} before=${before} after=${viewport.scrollTop} delta=${delta}`,
      )
    }
    return delta
  }

  return {
    snapshot,
    restoreSnapshot,
    available: (captured: QuickAssistantReadingSnapshot) => {
      const viewport = options.viewport()
      return !!viewport && !!findBlock(viewport, captured.key)
    },
  }
}
