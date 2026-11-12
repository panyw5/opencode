import { Show, type JSX } from "solid-js"

export function AgentSettingsGrid(props: { children: JSX.Element }) {
  return <div class="flex min-w-0 flex-wrap items-stretch gap-3">{props.children}</div>
}

export function AgentSettingsCard(props: {
  title?: string
  badge?: string
  size?: "compact" | "standard" | "wide"
  children: JSX.Element
}) {
  return (
    <section
      aria-label={props.title}
      class="min-w-0 max-w-full rounded-xl border border-border-base bg-surface-raised-base p-4"
      classList={{
        "w-fit flex-[0_1_auto]": props.size === "compact",
        "w-full flex-[1_1_20rem]": !props.size || props.size === "standard",
        "w-full flex-[1_1_100%]": props.size === "wide",
      }}
    >
      <Show when={props.title || props.badge}>
        <div class="mb-3 flex min-h-6 flex-wrap items-center gap-2">
          <Show when={props.title}>
            <h3 class="text-13-medium text-text-strong">{props.title}</h3>
          </Show>
          <Show when={props.badge}>
            <span class="rounded-md bg-surface-secondary px-1.5 py-0.5 text-11-medium text-text-weak">
              {props.badge}
            </span>
          </Show>
        </div>
      </Show>
      <div class="min-w-0 space-y-3">{props.children}</div>
    </section>
  )
}

export function AgentSettingsField(props: { children: JSX.Element; wide?: boolean }) {
  return (
    <div class="min-w-0 max-w-full" classList={{ "flex-[1_1_20rem]": props.wide, "flex-[0_1_auto]": !props.wide }}>
      {props.children}
    </div>
  )
}

export function AgentSettingsDetails(props: { title: string; children: JSX.Element; open?: boolean }) {
  return (
    <details class="group min-w-0 text-12-regular" open={props.open}>
      <summary class="w-fit max-w-full cursor-pointer rounded-md py-1 text-text-weak outline-none hover:text-text-base focus-visible:ring-2 focus-visible:ring-border-focus">
        {props.title}
      </summary>
      <div class="mt-3 min-w-0 space-y-3 text-text-weak">{props.children}</div>
    </details>
  )
}
