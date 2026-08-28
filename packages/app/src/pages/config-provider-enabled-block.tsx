import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { For, onMount } from "solid-js"
import type { ConfigProviderItem } from "./config-provider-list"
import { ProviderListButton } from "./config-provider-list-shared"

export default function ProviderEnabledBlock(props: {
  items: ConfigProviderItem[]
  activePick: string
  busyId: string
  modelsBadge: (count: number) => string
  groupLabel: string
  onSelect: (id: string) => void
  onToggle: (item: ConfigProviderItem, enabled: boolean) => void
}) {
  onMount(() => {
    console.info(`[config-perf] provider-enabled-block mount count=${String(props.items.length)}`)
  })

  return (
    <div class="flex flex-col gap-2.5">
      <div class="flex items-center justify-between gap-3 px-1">
        <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">{props.groupLabel}</div>
        <div class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
          {props.items.length}
        </div>
      </div>
      <For each={props.items}>
        {(item) => (
          <ProviderListButton
            active={props.activePick === `provider:${item.id}`}
            disabled={props.busyId === item.id}
            item={item}
            models={props.modelsBadge(item.models.length)}
            onClick={() => props.onSelect(item.id)}
            extra={
              <Toggle
                checked={item.custom ? item.allowed : item.connected}
                disabled={props.busyId === item.id || (!item.custom && item.source === "env")}
                onChange={(value) => props.onToggle(item, value)}
                hideLabel
              >
                {item.id}
              </Toggle>
            }
          />
        )}
      </For>
    </div>
  )
}
