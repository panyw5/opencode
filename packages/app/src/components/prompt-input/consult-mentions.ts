import type { CliAgentID, CliAgents, Platform } from "@/context/platform"
import type { Config } from "@opencode-ai/sdk/v2/client"

/** Reserved @-mention names for desktop CLI consult advisors (must match backend). */
export const CONSULT_MENTION_IDS = ["codex", "claude", "grok", "dsh", "pi", "gpt-pro"] as const satisfies readonly (
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
 * Include explicitly configured ACP advisors, then probe enabled desktop CLIs.
 * ACP commands are validated on invocation, not launched merely to open a menu.
 */
export async function loadReadyConsultMentions(
  cliAgents: CliAgents | undefined,
  gptPro?: Pick<NonNullable<Platform["gptPro"]>, "getConfig">,
  configuration?: Pick<Config, "agent_backends" | "external_agents" | "pi">,
): Promise<ReadyConsultMention[]> {
  const ready: ReadyConsultMention[] = []
  for (const id of ["codex", "claude", "grok", "dsh", "pi"] as const) {
    const backend = configuration?.agent_backends?.[id]
    if (backend?.type !== "acp" || !backend.command[0]?.trim()) continue
    const configured = id === "pi" ? configuration?.pi : configuration?.external_agents?.[id]
    if (configured?.enabled === false) continue
    if (configured?.enabled === undefined && cliAgents) {
      try {
        if ((await cliAgents.get(id)).enabled === false) continue
      } catch {
        continue
      }
    }
    const labels = { codex: "Codex", claude: "Claude", pi: "Pi", grok: "Grok", dsh: "DSH" }
    ready.push({ id, name: id, display: `${labels[id]} (ACP)` })
  }
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
    if (configuration?.agent_backends?.[descriptor.id]?.type === "acp") continue
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

export function consultMentionsFromPlatform(
  platform: Pick<Platform, "cliAgents" | "gptPro">,
  configuration?: Pick<Config, "agent_backends" | "external_agents" | "pi">,
) {
  return loadReadyConsultMentions(platform.cliAgents, platform.gptPro, configuration)
}
