import type { AcpAgentClient } from "./acp-client"
import type { Advisor } from "@/session/external-schema"
import type { ChannelOptions } from "@/session/channel-schema"

export function selectOptions(client: AcpAgentClient, category: "model" | "mode"): Array<{ id: string; name: string }> {
  const option = client.configOptions?.find(
    (item) => (item.category === category || item.id === category) && item.type === "select",
  )
  if (option && option.type === "select") {
    return option.options
      .flatMap((item) => ("options" in item ? item.options : [item]))
      .map((item) => ({ id: item.value, name: item.name ?? item.value }))
  }
  return []
}

export function modelOptions(client: AcpAgentClient) {
  const configured = selectOptions(client, "model")
  if (configured.length) return configured
  return (client.models?.availableModels ?? []).map((item) => ({
    id: item.modelId,
    name: item.name ?? item.modelId,
  }))
}

export function modeOptions(client: AcpAgentClient) {
  const configured = selectOptions(client, "mode")
  if (configured.length) return configured
  return (client.modes?.availableModes ?? []).map((item) => ({ id: item.id, name: item.name ?? item.id }))
}

export function channelOptions(client: AcpAgentClient, advisor: Advisor): ChannelOptions {
  return {
    advisor,
    ...(client.model ? { model: client.model } : {}),
    ...(client.mode ? { mode: client.mode } : {}),
    models: modelOptions(client),
    modes: modeOptions(client),
  }
}
