import type { Agent, Config } from "@opencode-ai/sdk/v2/client"
import { parse } from "jsonc-parser"

type RuntimeAgent = Pick<Agent, "name" | "description" | "mode" | "native" | "hidden" | "prompt">
type ConfiguredAgent = NonNullable<Config["agent"]>[string]

export type ConfigAgentDisplayItem = {
  name: string
  description?: string
  mode?: Agent["mode"]
  native?: boolean
  hidden?: boolean
  prompt?: string
  origin: "built-in" | "config" | "runtime"
}

export function configuredAgentsFromJsonc(input: string): Config["agent"] | undefined {
  const parsed: unknown = parse(input)
  if (typeof parsed !== "object" || parsed === null) return

  const agents = (parsed as Record<string, unknown>).agent
  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) return

  const entries = Object.entries(agents).filter(
    ([, value]) => typeof value === "object" && value !== null && !Array.isArray(value),
  )
  if (entries.length === 0) return
  return Object.fromEntries(entries) as Config["agent"]
}

/** Keep an existing JSONC variant selectable while model metadata catches up. */
export function jsoncAgentVariantOptions(variants: Record<string, unknown> | undefined, current: string): string[] {
  const options = Object.keys(variants ?? {})
  if (current && !options.includes(current)) options.push(current)
  return ["", ...options]
}

export function configAgentDisplayItems(input: {
  runtime: RuntimeAgent[]
  configured?: Config["agent"]
  definedNames: Iterable<string>
}): ConfigAgentDisplayItem[] {
  const defined = new Set(input.definedNames)
  const configured = input.configured ?? {}
  const runtime = new Map(input.runtime.map((item) => [item.name, item] as const))
  const names = [...runtime.keys(), ...Object.keys(configured).filter((name) => !runtime.has(name))]

  return names.flatMap((name) => {
    const item = runtime.get(name)
    const config = configured[name] as ConfiguredAgent | undefined
    if (defined.has(name) && !config) return []
    if (item?.hidden && !config) return []

    return [
      {
        name,
        description: item?.description ?? config?.description,
        mode: item?.mode ?? config?.mode,
        native: item?.native,
        hidden: item?.hidden ?? config?.hidden,
        prompt: item?.prompt ?? config?.prompt,
        origin: item?.native ? "built-in" : config ? "config" : "runtime",
      } satisfies ConfigAgentDisplayItem,
    ]
  })
}
