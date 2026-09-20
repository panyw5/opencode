export const TABLE_PREVIEW_MAX_ROWS = 1000
export const TABLE_PREVIEW_MAX_COLUMNS = 100
export const TABLE_PREVIEW_MAX_CHARS = 2_000_000

export function tableDelimiter(source: string) {
  let quoted = false
  let commas = 0
  let tabs = 0

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        index++
        continue
      }
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (char === ",") commas++
    if (char === "\t") tabs++
    if (char === "\n" || char === "\r") break
  }

  return tabs > commas ? "\t" : ","
}

export function parseDelimitedText(source: string, delimiter = tableDelimiter(source)) {
  const inputLength = Math.min(source.length, TABLE_PREVIEW_MAX_CHARS)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  let truncated = false
  let columnsTruncated = false

  const pushCell = () => {
    row.push(cell)
    cell = ""
  }
  const pushRow = () => {
    pushCell()
    if (row.length > TABLE_PREVIEW_MAX_COLUMNS) {
      row.length = TABLE_PREVIEW_MAX_COLUMNS
      columnsTruncated = true
    }
    if (row.some((value) => value !== "")) rows.push(row)
    row = []
    if (rows.length >= TABLE_PREVIEW_MAX_ROWS) truncated = true
  }

  for (let index = 0; index < inputLength && !truncated; index++) {
    const char = source[index]
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"'
        index++
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === delimiter && !quoted) {
      pushCell()
      continue
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index++
      pushRow()
      continue
    }
    cell += char
  }

  if (rows.length < TABLE_PREVIEW_MAX_ROWS && (cell.length > 0 || row.length > 0)) pushRow()
  return { rows, truncated: truncated || columnsTruncated || source.length > inputLength }
}
