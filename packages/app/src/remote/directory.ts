import type { Platform } from "@/context/platform"

type DirectoryResult = {
  path: string
  entries: { path: string; kind: "directory" }[]
}

export function createRemoteDirectoryPlatform(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  async function request(path: string, mode: "list" | "validate") {
    console.debug(`[remote-directory] request mode=${mode}`)
    const response = await fetcher(`/remote/api/directory?${new URLSearchParams({ path, mode })}`, {
      cache: "no-store",
    })
    console.debug(`[remote-directory] response mode=${mode} status=${response.status}`)
    if (mode === "validate" && response.status === 404) return undefined
    if (!response.ok) throw new Error(`Directory request failed (${response.status})`)
    const result = (await response.json()) as DirectoryResult
    console.debug(`[remote-directory] loaded mode=${mode} entries=${result.entries.length}`)
    return result
  }

  return {
    listLocalDirectory: async (path) => (await request(path, "list"))!.entries,
    filterDirectories: async (paths) => {
      const results = await Promise.all(paths.map((path) => request(path, "validate")))
      return results.flatMap((result) => (result ? [result.path] : []))
    },
  } satisfies Pick<Platform, "listLocalDirectory" | "filterDirectories">
}
