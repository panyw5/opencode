import { For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { GptProRuntimeStatus } from "@opencode-ai/util/gpt-pro"
import type { useLanguage } from "@/context/language"

import { AgentStatusCard as RuntimeCard, AgentStatusGrid, type AgentStatusTone as Tone } from "./agent-status-card"

export function GptProRuntimeCards(props: { runtime?: GptProRuntimeStatus; t: ReturnType<typeof useLanguage>["t"] }) {
  const phase = () => props.runtime?.session.authentication.phase ?? "unverified"
  const loginStatus = () => {
    if (phase() === "authenticated") return props.t("gptPro.auth.authenticated")
    if (phase() === "invalid") return props.t("gptPro.auth.needsLogin")
    if (phase() === "verification") return props.t("gptPro.auth.verification")
    if (phase() === "verifying") return props.t("gptPro.auth.loading")
    return props.t("gptPro.auth.unknown")
  }
  const loginTone = (): Tone =>
    phase() === "authenticated" ? "healthy" : ["invalid", "verification"].includes(phase()) ? "attention" : "neutral"
  return (
    <div class="@container mt-4" data-section="gpt-pro-runtime">
      <AgentStatusGrid>
        <RuntimeCard
          kind="identity"
          title={props.t("gptPro.card.login")}
          icon="circle-check"
          tone={loginTone()}
          value={loginStatus()}
          status="authentication"
          detail={props.runtime?.session.authentication.account}
          detailAlign="right"
        />
        <RuntimeCard
          kind="model"
          title={props.t("gptPro.card.model")}
          icon="models"
          tone="neutral"
          value={props.runtime?.session.page.model || props.t("gptPro.auth.unknown")}
          detail={props.t("gptPro.card.userSelected")}
        />
        <RuntimeCard
          kind="connection"
          title={props.t("gptPro.auth.bridge")}
          icon="server"
          tone={!props.runtime ? "neutral" : props.runtime.bridge.connected ? "healthy" : "attention"}
          value={
            !props.runtime
              ? props.t("gptPro.auth.unknown")
              : props.runtime.bridge.connected
                ? props.t("gptPro.auth.connected")
                : props.t("gptPro.auth.disconnected")
          }
        />
        <RuntimeCard
          kind="storage"
          title={props.t("gptPro.auth.storage")}
          icon="shield-check"
          tone={!props.runtime ? "neutral" : props.runtime.credentials.phase === "available" ? "healthy" : "attention"}
          value={
            !props.runtime
              ? props.t("gptPro.auth.unknown")
              : props.runtime.credentials.phase === "available"
                ? props.t("gptPro.card.encrypted")
                : props.t("gptPro.auth.storageUnavailable")
          }
        />
      </AgentStatusGrid>
      <Show when={props.runtime?.importBlocked}>
        <div
          class="mt-3 rounded-xl border border-border-warning-base/50 bg-surface-warning-weak/40 p-3"
          data-status="import-blocked"
        >
          <div class="flex items-start gap-2 text-12-medium text-text-warning-base">
            <Icon name="warning" size="small" />
            {props.t("gptPro.auth.importBlocked")}
          </div>
          <For each={props.runtime?.blockers}>
            {(job) => (
              <div class="mt-1.5 break-all pl-6 text-11-regular text-text-weak">
                {job.id} · {job.phase} · {job.ownerPage?.sessionID ?? "manual"}
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="mt-3 flex items-start gap-2 rounded-lg bg-background-base/60 px-3 py-2.5 text-12-regular leading-5 text-text-weak">
        <span aria-hidden="true" class="mt-0.5 shrink-0">
          <Icon name="lightbulb" size="small" />
        </span>
        <p>{props.t("gptPro.auth.note")}</p>
      </div>
    </div>
  )
}
