import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show } from "solid-js"
import { DialogInstallExtension } from "../components/dialog-install-extension"
import { useExtensionHost } from "../extensions/host"
import { pendingCatalogEntries } from "../extensions/catalog"
import { useLanguage } from "../context/language"
import type { InstallationOperations } from "./install-actions-state"

export interface ConfigExtensionCatalogProps {
  operations: InstallationOperations
  connection: () => unknown
}

/**
 * Built-in catalog placeholder: offers optional extensions that ship with the
 * app listing but are not installed yet. Installing opens the regular dialog
 * pre-filled with the entry's release URL; nothing is downloaded or enabled
 * without the user walking through the install confirmation.
 */
export function ConfigExtensionCatalog(props: ConfigExtensionCatalogProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const extensionHost = useExtensionHost()
  const entries = () => pendingCatalogEntries(extensionHost.extensions().map((item) => item.id))

  return (
    <Show when={entries().length > 0}>
      <div class="mt-3 flex flex-col gap-2" data-extension-catalog="">
        <For each={entries()}>
          {(entry) => (
            <div
              data-catalog-entry={entry.id}
              class="flex items-center justify-between gap-3 rounded-xl border border-border-weak-base bg-background-base px-4 py-3"
            >
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="text-13-medium text-text-strong">{entry.name}</span>
                <span class="text-12-regular text-text-weak">
                  {language.t("config.extensions.catalog.description")}
                </span>
              </div>
              <button
                type="button"
                class="h-8 shrink-0 rounded-lg border border-border-weak-base bg-surface-base px-3 text-12-medium text-text-base transition-colors hover:border-border-strong hover:bg-surface-base-hover"
                onClick={() => {
                  let closed: (() => void) | undefined
                  dialog.show(
                    () => (
                      <DialogInstallExtension
                        intent={{ kind: "install", releaseUrl: entry.releaseUrl }}
                        operations={props.operations}
                        language={{ t: (key) => language.t(key) }}
                        connection={props.connection}
                      />
                    ),
                    () => closed?.(),
                  )
                }}
              >
                {language.t("config.extensions.catalog.install")}
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
