import { mkdir, appendFile, readFile } from "fs/promises"
import path from "path"
import { dumps } from "./schema"

export async function appendJsonl(file: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, dumps(payload) + "\n", "utf8")
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

export async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }
  const out: Record<string, unknown>[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const payload = JSON.parse(trimmed)
      if (payload && typeof payload === "object" && !Array.isArray(payload)) out.push(payload)
    } catch {
      // skip garbage / JSONDecodeError, matching Danus read_jsonl
    }
  }
  return out
}

export * as MathJsonl from "./jsonl"
