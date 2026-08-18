import { Global } from "@opencode-ai/core/global"
import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import type { LimitReference } from "@opencode-ai/core/limit-reference"
import path from "path"

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
const CACHE_TTL_MS = 60 * 60 * 1000

type OpenRouterModel = {
  id?: string
  context_length?: number
  top_provider?: {
    context_length?: number
    max_completion_tokens?: number
  }
}

type CacheFile = {
  time: number
  models: Record<string, number>
}

let memory: { time: number; models: Record<string, number> } | undefined
let inflight: Promise<Record<string, number>> | undefined

function cachePath() {
  return path.join(Global.Path.cache, "openrouter-upstream.json")
}

function readDisk(): CacheFile | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile
  } catch {
    return
  }
}

async function writeDisk(models: Record<string, number>) {
  try {
    await writeFile(cachePath(), JSON.stringify({ time: Date.now(), models }))
  } catch {}
}

export function parseModels(payload: unknown) {
  const data = Array.isArray((payload as { data?: unknown }).data)
    ? ((payload as { data: OpenRouterModel[] }).data ?? [])
    : []
  const models: Record<string, number> = {}
  for (const item of data) {
    const id = item.id
    if (!id) continue
    const advertised = item.context_length ?? 0
    const upstream = item.top_provider?.context_length ?? advertised
    const context = Math.min(...[advertised, upstream].filter((value) => value > 0))
    if (context > 0) models[id] = context
  }
  return models
}

async function fetchModels() {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`openrouter models ${response.status}`)
  return parseModels(await response.json())
}

export async function openrouterUpstreamWindows() {
  if (memory && Date.now() - memory.time < CACHE_TTL_MS) return memory.models
  const disk = readDisk()
  if (disk && Date.now() - disk.time < CACHE_TTL_MS) {
    memory = disk
    return disk.models
  }
  if (!inflight) {
    inflight = fetchModels()
      .then(async (models) => {
        memory = { time: Date.now(), models }
        await writeDisk(models)
        return models
      })
      .finally(() => {
        inflight = undefined
      })
  }
  try {
    return await inflight
  } catch {
    if (disk?.models) return disk.models
    return {}
  }
}

export function applyOpenRouterUpstream(input: LimitReference | undefined, windows: Record<string, number>) {
  if (!input) return input
  if (!input.matchedID || !input.context) return input
  const upstream = windows[input.matchedID]
  if (!upstream || upstream >= input.context) return input
  return {
    ...input,
    context: upstream,
  }
}

export function openrouterUpstreamWindowsSync() {
  if (memory && Date.now() - memory.time < CACHE_TTL_MS) return memory.models
  const disk = readDisk()
  if (disk && Date.now() - disk.time < CACHE_TTL_MS) return disk.models
  return {}
}
