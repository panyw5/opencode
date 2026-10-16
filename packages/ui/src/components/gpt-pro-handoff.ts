import { type GptProAPI } from "@opencode-ai/util/gpt-pro"

export function closeDialogIfCurrent(
  dialog: { active?: { id: string }; close: () => void },
  expectedID: string | undefined,
) {
  if (!expectedID || dialog.active?.id !== expectedID) return false
  dialog.close()
  return true
}

export async function handoffGptPro(client: Pick<GptProAPI, "command">, id: string) {
  const job = await client.command({ action: "status", id })
  console.debug(`[gpt-pro-tool] view browser without pausing id=${job.id} phase=${job.phase}`)
  return client.command({ action: "open", id: job.id })
}
