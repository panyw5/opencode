/** Fixed geometry is shared by rendering, scrolling and pause navigation. */
export const LINE_HEIGHT = 20
export const CODE_PADDING_TOP = 8
export const VIRTUAL_THRESHOLD = 1000
const OVERSCAN = 12

export function visibleRange(count: number, scrollTop: number, height: number) {
  const first = Math.floor(Math.max(0, scrollTop - CODE_PADDING_TOP) / LINE_HEIGHT)
  const start = Math.min(Math.max(0, count - 1), Math.max(0, first - OVERSCAN))
  const end = Math.min(count, Math.max(start + 1, first + Math.ceil(Math.max(0, height) / LINE_HEIGHT) + OVERSCAN + 1))
  return { start, end }
}

export function centeredScrollTop(line: number, height: number) {
  return Math.max(0, CODE_PADDING_TOP + (line - 0.5) * LINE_HEIGHT - height / 2)
}

/** Reserve horizontal space even when the longest line is outside the window. */
export function maxColumns(lines: string[]) {
  let max = 0
  for (const line of lines) {
    let columns = 0
    for (let i = 0; i < line.length; i++) columns += line[i] === "\t" ? 4 - (columns % 4) : 1
    max = Math.max(max, columns)
  }
  return max
}
