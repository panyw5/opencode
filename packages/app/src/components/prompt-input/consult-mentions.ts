import type { CliAgentID, CliAgents, Platform } from "@/context/platform"

/** Reserved @-mention names for desktop CLI consult advisors (must match backend). */
export const CONSULT_MENTION_IDS = ["codex", "claude", "grok", "dsh", "gpt-pro"] as const satisfies readonly (
  | CliAgentID
  | "gpt-pro"
)[]

export type ConsultMentionID = (typeof CONSULT_MENTION_IDS)[number]

export type ReadyConsultMention = {
  id: ConsultMentionID
  name: ConsultMentionID
  display: string
}

const CONSULT_ID_SET = new Set<string>(CONSULT_MENTION_IDS)

export function isConsultMentionID(name: string): name is ConsultMentionID {
  return CONSULT_ID_SET.has(name)
}

/** Subagents with reserved consult names are hidden so @ always means consult when ready. */
export function filterAgentsForConsultMentions<T extends { name: string }>(agents: T[]): T[] {
  return agents.filter((agent) => !isConsultMentionID(agent.name))
}

/**
 * Probe desktop CLI advisors that are enabled and installed.
 * Returns [] when `cliAgents` is unavailable (non-desktop).
 */
export async function loadReadyConsultMentions(
  cliAgents: CliAgents | undefined,
  gptPro?: Pick<NonNullable<Platform["gptPro"]>, "getConfig">,
): Promise<ReadyConsultMention[]> {
  const ready: ReadyConsultMention[] = []
  if (gptPro) {
    try {
      if ((await gptPro.getConfig()).enabled)
        ready.push({ id: "gpt-pro", name: "gpt-pro", display: "GPT-6 Pro (Chat)" })
    } catch {
      /* older desktop version */
    }
  }
  if (!cliAgents) return ready

  let descriptors: Awaited<ReturnType<CliAgents["list"]>>
  try {
    descriptors = await cliAgents.list()
  } catch {
    return ready
  }

  for (const descriptor of descriptors) {
    if (!isConsultMentionID(descriptor.id)) continue
    try {
      const config = await cliAgents.get(descriptor.id)
      if (config.enabled === false) continue
      const info = await cliAgents.info(descriptor.id, config)
      if (!info.installed) continue
      ready.push({
        id: descriptor.id,
        name: descriptor.id,
        display: descriptor.label || descriptor.id,
      })
    } catch {
      // Skip agents that fail to probe; menu should only show known-ready items.
    }
  }
  return ready
}

export function consultMentionsFromPlatform(platform: Pick<Platform, "cliAgents" | "gptPro">) {
  return loadReadyConsultMentions(platform.cliAgents, platform.gptPro)
}
