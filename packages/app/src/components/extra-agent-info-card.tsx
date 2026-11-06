import { Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { ExtraAgentInfo } from "@/context/platform"
import type { useLanguage } from "@/context/language"
import { AgentStatusCard, AgentStatusGrid } from "./agent-status-card"

/** Stable version-card slots remain mounted before and during local requests. */
export function ExtraAgentInfoCard(props: {
  info?: ExtraAgentInfo
  loading?: boolean
  error?: string
  t: ReturnType<typeof useLanguage>["t"]
}) {
  const value = (input?: string) =>
    input?.trim() || props.t(props.loading && !props.info ? "common.loading" : "config.claws.info.unknown")
  return (
    <div
      class="@container rounded-2xl border border-border-weak-base bg-surface-base p-4"
      data-section="extra-agent-status"
      aria-busy={!!props.loading}
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="text-13-medium text-text-strong">{props.t("config.claws.info.title")}</div>
        <div
          class="inline-flex items-center gap-1.5 text-12-regular text-text-weak"
          classList={{ invisible: !props.loading }}
          aria-hidden={!props.loading}
          title={props.t("config.claws.info.refreshing")}
        >
          <Icon name="refresh" size="small" classList={{ "animate-spin": props.loading }} />
          <span>{props.t("config.claws.info.loading")}</span>
        </div>
      </div>
      <AgentStatusGrid class="mt-4">
        <AgentStatusCard
          kind="local-version"
          icon="terminal"
          tone="neutral"
          title={props.t("config.claws.info.localVersion")}
          value={value(props.info?.localVersion)}
        />
        <AgentStatusCard
          kind="latest-version"
          icon="download"
          tone="neutral"
          title={props.t("config.claws.info.latestVersion")}
          value={value(props.info?.latestVersion)}
        />
      </AgentStatusGrid>
      <Show when={props.error || props.info?.error}>
        {(error) => (
          <div role="alert" class="mt-3 break-words text-12-regular text-text-danger-base">
            {error()}
          </div>
        )}
      </Show>
    </div>
  )
}
