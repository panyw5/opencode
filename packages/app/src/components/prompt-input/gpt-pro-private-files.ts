const privateStageDirectory = /^gpt-pro-[a-z0-9]{6,}$/i

export function isLegacyGptProTransportPath(input: string) {
  const parts = input.replaceAll("\\", "/").split("/").filter(Boolean)
  for (let index = 0; index < parts.length - 1; index++) {
    if (parts[index]?.toLowerCase() !== ".opencode") continue
    if (!privateStageDirectory.test(parts[index + 1] ?? "")) continue

    // The former transport spool used mkdtemp(.opencode/gpt-pro-*)/<index>/<name>.
    // Also hide the spool directory itself when autocomplete returns directories.
    const tail = parts.slice(index + 2)
    if (tail.length === 0) return true
    if (tail.length === 1 && /^\d+$/.test(tail[0] ?? "")) return true
    if (tail.length === 2 && /^\d+$/.test(tail[0] ?? "") && !!tail[1]) return true
  }
  return false
}

export function filterAtFileSources(recent: string[], search: string[]) {
  const safeRecent: string[] = []
  const safeSearch: string[] = []
  let excluded = 0

  for (const path of recent) {
    if (isLegacyGptProTransportPath(path)) excluded += 1
    else safeRecent.push(path)
  }
  for (const path of search) {
    if (isLegacyGptProTransportPath(path)) excluded += 1
    else safeSearch.push(path)
  }

  return { recent: safeRecent, search: safeSearch, excluded }
}
