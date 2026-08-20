import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { For, onMount } from "solid-js"
import type { ConfigProviderItem } from "./config-provider-list"
import { ProviderListButton } from "./config-provider-list-shared"

export default function ProviderDisabledBlock(props: {
  items: ConfigProviderItem[]
  activePick: string
  busyId: string
  modelsBadge: (count: number) => string
  existingNote: string
  onSelect: (id: string) => void
  onToggle: (item: ConfigProviderItem, enabled: boolean) => void
}) {
  onMount(() => {
    console.info(`[config-perf] provider-disabled-block mount count=${String(props.items.length)}`)
  })

  return (
    <>
      <div class="rounded-xl border border-border-weak-base bg-surface-base px-3 py-2 text-12-regular text-text-weak">
        {props.existingNote}
      </div>
      <div class="flex flex-col gap-2.5">
        <For each={props.items}>
          {(item) => (
            <ProviderListButton
              active={props.activePick === `provider:${item.id}`}
              item={item}
              models={props.modelsBadge(item.models.length)}
              onClick={() => props.onSelect(item.id)}
              extra={
                <Toggle
                  checked={item.custom ? item.allowed : item.connected}
                  disabled={props.busyId === item.id}
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
    </>
  )
}
