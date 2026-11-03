import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Show, createSignal } from "solid-js"
import { useLanguage } from "../context/language"
import { runCatalogInstall, type CatalogFlowState } from "../extensions/catalog-install"
import type { CatalogEntry } from "../extensions/catalog"
import { usePlatform } from "../context/platform"
import type { InstallationOperations } from "./install-actions-state"

export interface ExtensionCardRowProps {
  /** Stable identifier exposed as data-extension-row for tests and debugging. */
  rowId?: string
  title: string
  subtitle: string
  note: string
  warn?: boolean
  active: boolean
  onSelect: () => void
}

/**
 * Middle-column card row shared by installed extensions and catalog entries,
 * matching the AGENTS.md card style.
 */
export function ExtensionCardRow(props: ExtensionCardRowProps) {
  const press = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onSelect()
  }
  return (
    <div
      role="button"
      tabIndex={0}
      data-extension-row={props.rowId}
      class="relative cursor-pointer overflow-hidden rounded-[14px] border bg-background-base/65 shadow-[inset_0_1px_0_color-mix(in_srgb,white_5%,transparent)] transition-colors"
      classList={{
        "border-border-base bg-surface-base/40": props.active,
        "border-border-weak-base/80 hover:border-border-base": !props.active,
      }}
      onClick={props.onSelect}
      onKeyDown={press}
    >
      <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--text-strong)_16%,transparent),transparent)]" />
      <div class="group flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left">
        <div class="flex min-w-0 items-center gap-3">
          <div
            class="flex size-9 shrink-0 items-center justify-center rounded-xl text-text-base transition-colors"
            classList={{
              "bg-surface-secondary text-text-strong": props.active,
              "bg-surface-secondary/60 group-hover:bg-surface-secondary group-hover:text-text-strong": !props.active,
            }}
          >
            <Icon name="dot-grid" size="small" />
          </div>
          <div class="min-w-0">
            <div class="truncate text-13-medium text-text-strong">{props.title}</div>
            <div class="mt-1 truncate font-mono text-[11px] leading-4 text-text-weak">{props.subtitle}</div>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <div
            class="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]"
            classList={{
              "border-border-danger-base/60 text-text-danger-base": !!props.warn,
              "border-border-weak-base bg-surface-secondary text-text-weak": !props.warn,
            }}
          >
            {props.note}
          </div>
          <div class="flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base text-text-weak transition-colors group-hover:border-border-base group-hover:text-text-base">
            <Icon name="chevron-right" size="small" />
          </div>
        </div>
      </div>
    </div>
  )
}

export interface ConfigExtensionCatalogDetailProps {
  entry: CatalogEntry
  operations: InstallationOperations
  connection: () => unknown
}

/**
 * Right-hand detail pane for a catalog entry. On desktop, Install downloads
 * the descriptor and archive through the renderer (system proxy applies),
 * verifies the digest and installs through the managed local-archive channel.
 * Without the desktop channel, the entry can still be installed by dragging a
 * manually downloaded .tgz archive onto this section.
 */
export function ConfigExtensionCatalogDetail(props: ConfigExtensionCatalogDetailProps) {
  const language = useLanguage()
  const platform = usePlatform()
  const [flow, setFlow] = createSignal<CatalogFlowState>({ stage: "descriptor" })

  const assisted = () =>
    typeof platform.extensionArchiveOp === "function" && typeof platform.extensionArchiveStage === "function"

  const start = async () => {
    if (flow().stage !== "descriptor" && flow().stage !== "error" && flow().stage !== "done") return
    setFlow({ stage: "descriptor" })
    try {
      await runCatalogInstall(
        props.entry,
        {
          stage: (bytes) => platform.extensionArchiveStage!(bytes),
          op: (op, payload) => platform.extensionArchiveOp!(op, payload),
          cleanup: (path) => Promise.resolve(platform.extensionArchiveCleanup?.(path)),
        },
        (stage, message) => setFlow({ stage, message }),
      )
    } catch (error) {
      const code = (error as { code?: string }).code
      setFlow({
        stage: "error",
        message:
          code === "conflict"
            ? language.t("config.extensions.catalog.conflictCleanup")
            : error instanceof Error
              ? error.message
              : String(error),
      })
    }
  }

  const stageLabel = () => {
    switch (flow().stage) {
      case "descriptor":
        return language.t("config.extensions.catalog.flowDescriptor")
      case "artifact":
        return language.t("config.extensions.catalog.flowArtifact")
      case "ready":
        return language.t("config.extensions.catalog.flowReady")
      case "preparing":
        return language.t("config.extensions.catalog.flowPreparing")
      case "committing":
        return language.t("config.extensions.catalog.flowCommitting")
      case "done":
        return language.t("config.extensions.catalog.flowDone")
      case "error":
        return flow().message ?? language.t("config.extensions.catalog.flowFailed")
    }
  }

  return (
    <div class="flex flex-col gap-4" data-extension-catalog-detail={props.entry.id}>
      <div class="flex flex-col gap-1">
        <h2 class="text-15-medium text-text-strong">{props.entry.name}</h2>
        <p class="text-12-regular text-text-weak">{props.entry.author}</p>
      </div>
      <p class="text-13-regular text-text-base">{language.t("config.extensions.catalog.description")}</p>
      <div class="flex flex-col gap-1 text-12-regular text-text-weak">
        <span>{language.t("config.extensions.catalog.source")}</span>
        <code class="break-all font-mono text-text-base">{props.entry.releaseUrl}</code>
      </div>
      <Show
        when={assisted()}
        fallback={<p class="text-12-regular text-text-weak">{language.t("config.extensions.catalog.dragHint")}</p>}
      >
        <div class="flex items-center gap-3">
          <button
            type="button"
            data-action="catalog-install"
            class="h-8 rounded-lg border border-border-weak-base bg-surface-base px-3 text-12-medium text-text-base transition-colors hover:border-border-strong hover:bg-surface-base-hover disabled:opacity-50"
            disabled={["artifact", "preparing", "committing", "done"].includes(flow().stage)}
            onClick={() => void start()}
          >
            {language.t("config.extensions.catalog.install")}
          </button>
          <Show when={flow().stage !== "descriptor" || flow().message}>
            <span class="flex items-center gap-2 text-12-regular text-text-weak" data-flow-stage={flow().stage}>
              <Show when={["artifact", "preparing", "committing"].includes(flow().stage)}>
                <Spinner class="size-3.5" />
              </Show>
              {stageLabel()}
            </span>
          </Show>
        </div>
      </Show>
    </div>
  )
}
