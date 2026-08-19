export const SKILL_MARKET_MAX_SKILLS = 80
export const SKILL_MARKET_INDEX_SOURCE_TIMEOUT_MS = 8_000

export type SkillMarketIndexKind = "ungh" | "github" | "jsdelivr"

export type SkillMarketRepoRef = {
  repo: string
  branch?: string
  path?: string
}

export type SkillMarketIndexFile = {
  name?: string
  path?: string
  type?: string
}

export type SkillMarketIndexResult = {
  branch: string
  paths: string[]
  source: SkillMarketIndexKind
}

const NESTED_SKILL_ROOTS = ["skills", "skill", ".agents/skills", ".claude/skills", ".opencode/skills"] as const

export function isSkillMarkdownPath(path: string) {
  return /(^|\/)SKILL\.md$/i.test(normalizeRepoFilePath(path))
}

export function normalizeRepoFilePath(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "")
}

export function skillMarketRepoPathPrefix(path: string | undefined) {
  const normalized = path?.trim().replace(/^\/+|\/+$/g, "")
  return normalized ? `${normalized}/` : ""
}

export function cdnPath(path: string) {
  return normalizeRepoFilePath(path).split("/").map(encodeURIComponent).join("/")
}

export function skillMarketContentUrls(repo: string, branch: string, path: string) {
  const encodedBranch = encodeURIComponent(branch)
  const file = cdnPath(path)
  return [
    `https://cdn.jsdelivr.net/gh/${repo}@${encodedBranch}/${file}`,
    `https://raw.githubusercontent.com/${repo}/${encodedBranch}/${file}`,
  ]
}

export function skillMarketIndexSources(repo: string, branch: string): Array<{ kind: SkillMarketIndexKind; url: string }> {
  const encodedBranch = encodeURIComponent(branch)
  return [
    { kind: "ungh", url: `https://ungh.cc/repos/${repo}/files/${encodedBranch}` },
    { kind: "github", url: `https://api.github.com/repos/${repo}/git/trees/${encodedBranch}?recursive=1` },
    { kind: "jsdelivr", url: `https://data.jsdelivr.com/v1/package/gh/${repo}@${encodedBranch}/flat` },
  ]
}

export function skillMarketIndexFiles(kind: SkillMarketIndexKind, data: unknown): SkillMarketIndexFile[] {
  if (!data || typeof data !== "object") return []
  const record = data as Record<string, unknown>

  if (kind === "github") {
    if (record.truncated === true) return []
    if (!Array.isArray(record.tree)) return []
    return record.tree.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const entry = item as Record<string, unknown>
      return [
        {
          path: typeof entry.path === "string" ? entry.path : undefined,
          type: typeof entry.type === "string" ? entry.type : undefined,
        },
      ]
    })
  }

  if (!Array.isArray(record.files)) return []
  return record.files.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const entry = item as Record<string, unknown>
    return [
      {
        name: typeof entry.name === "string" ? entry.name : undefined,
        path: typeof entry.path === "string" ? entry.path : undefined,
        type: typeof entry.type === "string" ? entry.type : undefined,
      },
    ]
  })
}

export function resolveNestedSkillPaths(paths: string[], root?: string) {
  const normalized = paths.map(normalizeRepoFilePath).filter(isSkillMarkdownPath)
  const prefix = skillMarketRepoPathPrefix(root)
  const underPrefix = prefix
    ? normalized.filter((path) => path.startsWith(prefix) || path === prefix.slice(0, -1))
    : normalized
  if (underPrefix.length) return underPrefix

  for (const nested of NESTED_SKILL_ROOTS) {
    const next = `${prefix}${nested}/`
    const hits = normalized.filter((path) => path.startsWith(next))
    if (hits.length) return hits
  }

  return []
}

export function collectSkillMarkdownPaths(files: SkillMarketIndexFile[], options?: { root?: string; max?: number }) {
  const max = options?.max ?? SKILL_MARKET_MAX_SKILLS
  const paths = files
    .map((item) => {
      const raw = typeof item.path === "string" ? item.path : typeof item.name === "string" ? item.name : ""
      return normalizeRepoFilePath(raw)
    })
    .filter((path, index) => {
      if (!path) return false
      const type = files[index]?.type
      if (type && type !== "file" && type !== "blob") return false
      return isSkillMarkdownPath(path)
    })

  return resolveNestedSkillPaths(paths, options?.root).slice(0, max)
}

export function parseSkillMarketIndex(kind: SkillMarketIndexKind, data: unknown, root?: string) {
  return collectSkillMarkdownPaths(skillMarketIndexFiles(kind, data), { root })
}

async function marketJSON<T>(fetcher: typeof fetch, url: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetcher(url, { signal })
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
  return resp.json() as Promise<T>
}

async function withIndexTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Skill marketplace index request timed out after ${timeoutMs / 1000}s`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function probeSkillMarketPath(
  fetcher: typeof fetch,
  repo: string,
  branch: string,
  path: string,
  signal?: AbortSignal,
) {
  for (const url of skillMarketContentUrls(repo, branch, path)) {
    try {
      const resp = await fetcher(url, { signal })
      if (resp.ok) return true
    } catch {
      // Try the next content host.
    }
  }
  return false
}

export async function loadSkillMarketIndex(
  repo: SkillMarketRepoRef,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<SkillMarketIndexResult> {
  const branches = repo.branch ? [repo.branch] : ["main", "master"]
  let lastErr: unknown

  for (const branch of branches) {
    for (const source of skillMarketIndexSources(repo.repo, branch)) {
      try {
        console.log(`[skill-market] fetch index repo=${repo.repo} branch=${branch} source=${source.kind} path=${repo.path ?? ""}`)
        const data = await withIndexTimeout(marketJSON<unknown>(fetcher, source.url, signal), SKILL_MARKET_INDEX_SOURCE_TIMEOUT_MS)
        const paths = parseSkillMarketIndex(source.kind, data, repo.path)
        console.log(
          `[skill-market] index parsed repo=${repo.repo} branch=${branch} source=${source.kind} skills=${String(paths.length)}`,
        )
        if (!paths.length) {
          lastErr = new Error(`${source.kind} index had no SKILL.md`)
          continue
        }

        const live = await probeSkillMarketPath(fetcher, repo.repo, branch, paths[0]!, signal)
        if (!live) {
          console.warn(
            `[skill-market] stale index repo=${repo.repo} branch=${branch} source=${source.kind} sample=${paths[0]}`,
          )
          lastErr = new Error(`${source.kind} index paths are stale`)
          continue
        }

        console.log(`[skill-market] index ready repo=${repo.repo} branch=${branch} source=${source.kind} skills=${String(paths.length)}`)
        return { branch, paths, source: source.kind }
      } catch (err) {
        lastErr = err
        console.warn(
          `[skill-market] index failed repo=${repo.repo} branch=${branch} source=${source.kind} error=${String(err)}`,
        )
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Skill marketplace index failed"))
}

export async function fetchSkillMarketFile(
  fetcher: typeof fetch,
  repo: string,
  branch: string,
  path: string,
  signal?: AbortSignal,
) {
  let lastErr: unknown
  for (const url of skillMarketContentUrls(repo, branch, path)) {
    try {
      const resp = await fetcher(url, { signal })
      if (!resp.ok) {
        lastErr = new Error(`${resp.status} ${resp.statusText}`)
        console.warn(
          `[skill-market] skill response failed repo=${repo} branch=${branch} path=${path} url=${url} status=${String(resp.status)}`,
        )
        continue
      }
      return { url, content: await resp.text() }
    } catch (err) {
      lastErr = err
      console.warn(`[skill-market] skill fetch failed repo=${repo} branch=${branch} path=${path} url=${url} error=${String(err)}`)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Skill file fetch failed"))
}
