import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { ExtensionCard } from "../components/extension-card"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { DialogInstallExtension } from "../components/dialog-install-extension"
import { useLanguage } from "../context/language"
import type { CatalogEntry } from "../extensions/catalog"
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

/** Middle-column card shared by installed extensions and catalog entries. */
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
      class="relative cursor-pointer overflow-hidden rounded-[14px] border bg-background-base/65 transition-colors"
      classList={{
        "border-border-base bg-surface-base/40": props.active,
        "border-border-weak-base/80 hover:border-border-base": !props.active,
      }}
      onClick={props.onSelect}
      onKeyDown={press}
    >
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
  refresh: () => Promise<void>
  installed: () => boolean
  enabled?: boolean
  busy?: boolean
}

/** Catalog installs use the same release preview and explicit confirmation as manual installs. */
export function ConfigExtensionCatalogDetail(props: ConfigExtensionCatalogDetailProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let alive = true
  onCleanup(() => {
    alive = false
  })
  onMount(() => {
    void props.refresh().catch(() => {
      if (alive) setError(true)
    })
  })
  const start = async () => {
    if (busy() || props.busy || props.enabled === false) return
    const connection = props.connection()
    setBusy(true)
    setError(false)
    try {
      await props.refresh()
      if (!alive || props.connection() !== connection || props.installed()) return
      console.info(`[extension-catalog] release dialog open id=${props.entry.id}`)
      let closed: (() => void) | undefined
      dialog.show(
        () => (
          <DialogInstallExtension
            intent={{ kind: "install", releaseUrl: props.entry.releaseUrl }}
            operations={{
              ...props.operations,
              prepareInstallation: async (request) => {
                const prepared = await props.operations.prepareInstallation(request)
                if (prepared.id === props.entry.id) return prepared
                await props.operations.cancelInstallation(prepared).catch(() => {})
                throw new Error("Release candidate identity mismatch")
              },
            }}
            connection={props.connection}
            language={language}
            enabled={props.enabled}
            busy={props.busy}
            registerClose={(callback) => {
              closed = callback
            }}
          />
        ),
        () => closed?.(),
      )
    } catch {
      if (alive) setError(true)
      console.warn(`[extension-catalog] refresh failed id=${props.entry.id}`)
    } finally {
      if (alive) setBusy(false)
    }
  }
  return (
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-4" data-extension-catalog-detail={props.entry.id}>
      <ExtensionCard>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <h2 class="break-words text-20-medium text-text-strong">{props.entry.name}</h2>
            <p class="mt-1 text-12-regular text-text-weak">{props.entry.author}</p>
          </div>
          <Button
            variant="primary"
            data-action="catalog-install"
            disabled={busy() || props.busy || props.enabled === false || props.installed()}
            onClick={() => void start()}
          >
            {language.t("config.extensions.catalog.install")}
          </Button>
        </div>
        <p class="text-13-regular leading-relaxed text-text-base">
          {language.t("config.extensions.catalog.description")}
        </p>
        <Show when={error()}>
          <span role="alert" class="text-12-regular text-text-danger-base">
            {language.t("config.extensions.install.failed")}
          </span>
        </Show>
      </ExtensionCard>
      <ExtensionCard title={language.t("config.extensions.catalog.source")}>
        <code class="break-all font-mono text-12-regular text-text-base">{props.entry.releaseUrl}</code>
      </ExtensionCard>
    </div>
  )
}
