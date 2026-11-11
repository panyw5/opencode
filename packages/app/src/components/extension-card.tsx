import { For, Show, type JSX } from "solid-js"

/** Shared section treatment for extension details and installation previews. */
export function ExtensionCard(props: { title?: string; children: JSX.Element; class?: string }) {
  return (
    <section
      data-component="extension-card"
      class={`flex min-w-0 flex-col gap-3 rounded-lg border border-border-weak-base bg-surface-base/30 p-4 ${props.class ?? ""}`}
    >
      <Show when={props.title}>
        <h3 class="text-13-medium text-text-strong">{props.title}</h3>
      </Show>
      {props.children}
    </section>
  )
}

const contributionKeys = ["fileViewers", "toolRenderers", "commands", "panels", "settings"] as const
type ContributionKey = (typeof contributionKeys)[number]
type Contributions = Partial<Record<Exclude<ContributionKey, "settings">, readonly unknown[]>> & { settings?: object }

/** Compact contribution counts shared by installed and previewed extensions. */
export function ExtensionContributions(props: {
  contributes: Contributions
  t: (key: `config.extensions.install.${ContributionKey}`) => string
}) {
  return (
    <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3" data-extension-contributions>
      <For each={contributionKeys}>
        {(key) => (
          <div class="flex min-w-0 flex-col gap-1 rounded-md bg-surface-secondary/50 px-3 py-2">
            <dt class="text-12-regular text-text-weak">{props.t(`config.extensions.install.${key}`)}</dt>
            <dd class="text-16-medium tabular-nums text-text-strong">
              {key === "settings"
                ? Object.keys(props.contributes.settings ?? {}).length
                : (props.contributes[key]?.length ?? 0)}
            </dd>
          </div>
        )}
      </For>
    </dl>
  )
}
