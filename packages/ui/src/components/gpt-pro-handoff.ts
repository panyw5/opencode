import { gptProTerminal, type GptProAPI } from "@opencode-ai/util/gpt-pro"

export async function handoffGptPro(client: Pick<GptProAPI, "command">, id: string) {
  const job = await client.command({ action: "status", id })
  console.debug(`[gpt-pro-tool] direct browser intervention id=${job.id} phase=${job.phase}`)
  if (!["preparing", "sending", "generating"].includes(job.phase)) return client.command({ action: "open", id: job.id })
  try {
    return await client.command({ action: "pause", id: job.id })
  } catch (error) {
    // Completion may race with the click; never restart or resend that question.
    const current = await client.command({ action: "status", id: job.id })
    if (!gptProTerminal(current.phase)) throw error
    return client.command({ action: "open", id: current.id })
  }
}
