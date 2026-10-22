function cleanFrontmatterValue(value: string) {
  return value.trim().replace(/\s+/g, " ")
}

export function frontmatterData(text: string) {
  const hit = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!hit) return

  const lines = hit[1].split(/\r?\n/)
  const data: Record<string, string> = {}

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!line) continue

    const key = line[1]
    const raw = line[2].trim()
    const block = raw.match(/^([|>])[-+]?$/)

    if (block) {
      const blockLines: string[] = []
      for (let next = index + 1; next < lines.length; next++) {
        const blockLine = lines[next]
        if (/^[A-Za-z0-9_-]+:\s*/.test(blockLine) || (blockLine.trim() && !/^\s/.test(blockLine))) {
          index = next - 1
          break
        }

        blockLines.push(blockLine)
        index = next
      }

      const indents = blockLines
        .filter((blockLine) => blockLine.trim())
        .map((blockLine) => blockLine.match(/^\s*/)?.[0].length ?? 0)
      const indent = indents.length ? Math.min(...indents) : 0
      data[key] = cleanFrontmatterValue(
        blockLines
          .map((blockLine) => blockLine.slice(Math.min(indent, blockLine.length)))
          .join(block[1] === ">" ? " " : "\n"),
      )
      continue
    }

    data[key] = cleanFrontmatterValue(raw.replace(/^['"]|['"]$/g, ""))
  }

  return data
}
