import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return
  const next = value.trim()
  return next || undefined
}

type CompletedSkillPart = ToolPart & {
  state: Extract<ToolPart["state"], { status: "completed" }>
}

const loadedSkill = (part: Part): part is CompletedSkillPart => {
  return part.type === "tool" && part.tool.trim().toLowerCase() === "skill" && part.state.status === "completed"
}

/** Returns successfully loaded skills in the order this session first activated them. */
export function collectSessionActiveSkills(input: {
  messages: readonly Message[]
  parts: Record<string, readonly Part[] | undefined>
}): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const message of input.messages) {
    for (const part of input.parts[message.id] ?? []) {
      if (!loadedSkill(part)) continue
      const name = text(part.state.input.name) ?? text(part.state.metadata?.name)
      if (!name || seen.has(name)) continue
      seen.add(name)
      result.push(name)
    }
  }

  return result
}
