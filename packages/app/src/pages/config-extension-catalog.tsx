import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show } from "solid-js"
import { DialogInstallExtension } from "../components/dialog-install-extension"
import { useLanguage } from "../context/language"
import type { CatalogEntry } from "../extensions/catalog"
import type { InstallationOperations } from "./install-actions-state"

export interface ConfigExtensionCatalogEntryProps {
  entry: CatalogEntry
  active: boolean
  onSelect: () => void
}

/**
 * Middle-column list row for a catalog entry: title and author only. Details
 * and the install action live in the right-hand detail pane.
 */
export function ConfigExtensionCatalogEntry(props: ConfigExtensionCatalogEntryProps) {
  return (
    <button
      type="button"
      data-catalog-entry={props.entry.id}
      class="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-base-hover"
      classList={{ "bg-surface-base-active": props.active }}
      onClick={props.onSelect}
    >
      <span class="text-13-medium text-text-strong">{props.entry.name}</span>
      <span class="text-12-regular text-text-weak">{props.entry.author}</span>
    </button>
  )
}

export interface ConfigExtensionCatalogDetailProps {
  entry: CatalogEntry
  operations: InstallationOperations
  connection: () => unknown
}

/**
 * Right-hand detail pane for a catalog entry: description, requirements and
 * the install action. Installing opens the regular dialog pre-filled with the
 * entry's release URL; nothing is downloaded without the install confirmation.
 */
export function ConfigExtensionCatalogDetail(props: ConfigExtensionCatalogDetailProps) {
  const dialog = useDialog()
  const language = useLanguage()

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
      <div>
        <button
          type="button"
          data-action="catalog-install"
          class="h-8 rounded-lg border border-border-weak-base bg-surface-base px-3 text-12-medium text-text-base transition-colors hover:border-border-strong hover:bg-surface-base-hover"
          onClick={() => {
            dialog.show(() => (
              <DialogInstallExtension
                intent={{ kind: "install", releaseUrl: props.entry.releaseUrl }}
                operations={props.operations}
                language={{ t: (key) => language.t(key) }}
                connection={props.connection}
              />
            ))
          }}
        >
          {language.t("config.extensions.catalog.install")}
        </button>
      </div>
    </div>
  )
}
