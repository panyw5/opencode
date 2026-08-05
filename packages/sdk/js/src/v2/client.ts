export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-opencode-directory", "directory"],
    ["x-opencode-workspace", "workspace"],
  ] as const) {
    const rawHeader = request.headers.get(name)
    const fallback = key === "directory" ? values.directory : values.workspace
    const value = pick(rawHeader, fallback, key === "directory" ? encodeURIComponent : undefined)
    // eslint-disable-next-line no-console
    if (key === "directory") {
      console.log(
        `[sdk/v2] rewrite url=${request.url} rawHeader=${rawHeader} fallback=${fallback} picked=${value} encoded=${value ? encodeURIComponent(value) : undefined}`,
      )
    }
    if (!value) continue
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-opencode-workspace")
  return next
}

function normalizeDirectory(directory: string) {
  return directory.replace(/\\/g, "/")
}

export function createOpencodeClient(
  config?: Config & { directory?: string; experimental_workspaceID?: string },
): OpencodeClient & { directory?: string } {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  const normalizedDirectory = config?.directory ? normalizeDirectory(config.directory) : undefined

  if (normalizedDirectory) {
    // eslint-disable-next-line no-console
    console.log(
      `[sdk/v2] createOpencodeClient original=${config.directory} normalized=${normalizedDirectory} encoded=${encodeURIComponent(normalizedDirectory)}`,
    )
    config = {
      ...config,
      directory: normalizedDirectory,
      headers: {
        ...config.headers,
        "x-opencode-directory": encodeURIComponent(normalizedDirectory),
      },
    }
  }

  if (config?.experimental_workspaceID) {
    config = {
      ...config,
      headers: {
        ...config.headers,
        "x-opencode-workspace": config.experimental_workspaceID,
      },
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: normalizedDirectory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  const sdk = new OpencodeClient({ client })
  ;(sdk as any).directory = normalizedDirectory
  return sdk as OpencodeClient & { directory?: string }
}
