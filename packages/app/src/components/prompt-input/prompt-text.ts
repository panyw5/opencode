import type { Prompt } from "@/context/prompt"

export function promptText(prompt: Prompt) {
  const text = prompt.map((part) => ("content" in part ? part.content : "")).join("")
  const im = prompt.find((part) => part.type === "im")
  if (!im || im.type !== "im") return text
  const target = im.channelName
    ? `the ${im.channelName} channel${im.botName ? ` (bot: ${im.botName})` : ""}`
    : "an available IM channel"
  return `${text}\n\nIM channel reference: if IM sending is needed, use im_list to verify ${target}, then use im_send({ channelName, text }) to send to its configured recipient. If unavailable, do not invent a channel name or recipient.`
}
