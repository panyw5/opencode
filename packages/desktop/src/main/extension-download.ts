import { MAX_ARCHIVE_BYTES } from "@opencode-ai/util/extension-release"

export type ArchiveFetch = (url: string, init: RequestInit) => Promise<Response>

const MAX_BYTES = MAX_ARCHIVE_BYTES

function target(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash || /[\s\\\u0000-\u001f\u007f]/.test(value))
    throw new Error("HTTPS archive URL without credentials required")
  return url.href
}

/** Chromium proxy transport with an HTTPS check before every redirect request. */
export async function downloadExtensionArchive(url: string, fetcher: ArchiveFetch): Promise<Uint8Array> {
  let current = target(url)
  const signal = AbortSignal.timeout(120_000)
  for (let redirects = 0; ; redirects++) {
    const response = await fetcher(current, { redirect: "manual", credentials: "omit", signal })
    console.info(`[extension-download] response status=${response.status} type=${response.type} hop=${redirects}`)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get("location")
      if (!location || redirects >= 3) throw new Error("Archive redirect limit exceeded")
      current = target(new URL(location, current).href)
      continue
    }
    if (!response.ok) throw new Error("Archive download failed")
    if (response.url && new URL(response.url).protocol !== "https:") {
      await response.body?.cancel()
      throw new Error("HTTPS archive URL without credentials required")
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel()
      throw new Error("Archive exceeds the 100 MiB download limit")
    }
    const chunks: Uint8Array[] = []
    let length = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Archive download failed")
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_BYTES) throw new Error("Archive exceeds the 100 MiB download limit")
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }
}
