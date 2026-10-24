import { gptProStateStore } from "./gpt-pro-state"
import type { GptProStateClient } from "@opencode-ai/util/gpt-pro-store"

export function closeDialogIfCurrent(
  dialog: { active?: { id: string }; close: () => void },
  expectedID: string | undefined,
) {
  if (!expectedID || dialog.active?.id !== expectedID) return false
  dialog.close()
  return true
}

export async function handoffGptPro(client: GptProStateClient, id: string) {
  const commands = gptProStateStore(client)
  const job = await commands.command({ action: "status", id })
  console.debug(`[gpt-pro-tool] view browser without pausing id=${job.id} phase=${job.phase}`)
  return commands.command({ action: "open", id: job.id })
}
