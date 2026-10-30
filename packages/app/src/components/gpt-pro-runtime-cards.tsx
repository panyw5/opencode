import { For, Show } from "solid-js"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import type { GptProRuntimeStatus } from "@opencode-ai/util/gpt-pro"
import type { useLanguage } from "@/context/language"

type Tone = "healthy" | "attention" | "neutral"

function RuntimeCard(props: {
  kind: string
  title: string
  icon: IconName
  tone: Tone
  value: string
  status?: string
  featured?: boolean
  detail?: string
}) {
  return (
    <article
      data-runtime-card={props.kind}
      data-tone={props.tone}
      class="min-w-0 rounded-xl border bg-surface-base px-3 py-2.5 shadow-xs-border-base"
      classList={{
        "border-border-success-base/30": props.tone === "healthy",
        "bg-gradient-to-br from-surface-success-weak/40 to-surface-base": props.tone === "healthy" && props.featured,
        "border-border-warning-base/50 bg-gradient-to-br from-surface-warning-weak/45 to-surface-base":
          props.tone === "attention",
        "border-border-weak-base": props.tone === "neutral",
      }}
    >
      <div class="flex items-start gap-2" data-runtime-header>
        <span
          aria-hidden="true"
          class="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border-weak-base/60 bg-surface-base/80"
          classList={{
            "text-text-success-base": props.tone === "healthy",
            "text-text-warning-base": props.tone === "attention",
            "text-icon-base": props.tone === "neutral",
          }}
        >
          <Icon
            name={props.icon}
            size="normal"
            classList={{
              "text-icon-success-base": props.tone === "healthy",
              "text-text-warning-base": props.tone === "attention",
            }}
          />
        </span>
        <div class="min-w-0 flex-1 pt-0.5">
          <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h4 class="min-w-0 text-12-medium leading-5 text-text-weak">{props.title}</h4>
            <div
              data-runtime-value
              data-status={props.status}
              class="break-words text-12-medium leading-5 text-text-strong"
              style={{ "font-weight": 600 }}
            >
              {props.value}
            </div>
          </div>
          <Show when={props.detail}>
            <div
              class="mt-0.5 text-12-regular leading-5 text-text-weak"
              classList={{
                "break-all select-text text-right": props.kind === "identity",
                "break-words": props.kind !== "identity",
              }}
            >
              {props.detail}
            </div>
          </Show>
        </div>
        <span
          aria-hidden="true"
          class="mt-2.5 size-1.5 shrink-0 rounded-full"
          classList={{
            "bg-text-success-base": props.tone === "healthy",
            "bg-text-warning-base": props.tone === "attention",
            "bg-icon-weak": props.tone === "neutral",
          }}
        />
      </div>
    </article>
  )
}

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
    phase() === "authenticated"
      ? "healthy"
      : ["invalid", "verification"].includes(phase())
        ? "attention"
        : "neutral"
  return (
    <div class="@container mt-4" data-section="gpt-pro-runtime">
      <div class="grid grid-cols-1 gap-2 @[34rem]:grid-cols-2 @[64rem]:grid-cols-4" aria-live="polite">
        <RuntimeCard
          kind="identity"
          title={props.t("gptPro.card.login")}
          icon="circle-check"
          tone={loginTone()}
          value={loginStatus()}
          status="authentication"
          featured
          detail={props.runtime?.session.authentication.account}
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
      </div>
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
