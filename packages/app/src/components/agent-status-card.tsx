import { Show, type JSX } from "solid-js"
import { Icon, type IconName } from "@opencode-ai/ui/icon"

export type AgentStatusTone = "healthy" | "attention" | "neutral"

/** Compact status summary shared by external-agent settings. */
export function AgentStatusCard(props: {
  kind: string
  title: string
  icon: IconName
  tone: AgentStatusTone
  value: string
  status?: string
  detail?: string
  detailAlign?: "left" | "right"
  monospace?: boolean
  loading?: boolean
  action?: JSX.Element
}) {
  return (
    <article
      data-runtime-card={props.kind}
      data-tone={props.tone}
      class="min-w-0 rounded-xl border px-3 py-2.5"
      classList={{
        "bg-surface-success-weak/40": props.tone === "healthy",
        "bg-surface-base": props.tone !== "healthy",
        "border-border-warning-base/50 bg-gradient-to-br from-surface-warning-weak/45 to-surface-base":
          props.tone === "attention",
        "border-border-weak-base": props.tone !== "attention",
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
              "animate-spin": props.loading,
            }}
          />
        </span>
        <div class="min-w-0 flex-1 pt-0.5">
          <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h4 class="min-w-0 text-12-medium leading-5 text-text-weak">{props.title}</h4>
            <div
              data-runtime-value
              data-status={props.status}
              class="min-w-0 max-w-full text-12-medium leading-5 text-text-strong"
              classList={{ "font-mono break-all select-text": props.monospace, "break-words": !props.monospace }}
              style={{ "font-weight": 600 }}
            >
              {props.value}
            </div>
          </div>
          <Show when={props.detail}>
            <div
              class="mt-0.5 text-12-regular leading-5 text-text-weak"
              classList={{
                "break-all select-text text-right": props.detailAlign === "right",
                "break-words": props.detailAlign !== "right",
              }}
            >
              {props.detail}
            </div>
          </Show>
        </div>
        {props.action}
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

/** Respond to the settings panel width rather than the full window width. */
export function AgentStatusGrid(props: { children: JSX.Element; class?: string }) {
  return (
    <div
      class={"grid grid-cols-1 gap-2 @[34rem]:grid-cols-2 @[64rem]:grid-cols-4 " + (props.class ?? "")}
      data-status-grid
      aria-live="polite"
    >
      {props.children}
    </div>
  )
}
