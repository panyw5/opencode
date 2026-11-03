import { Button } from "@opencode-ai/ui/button"
import type { ExtensionInfo } from "../extensions/types"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show } from "solid-js"
import { DialogInstallExtension, type ExtensionInstallationProps } from "../components/dialog-install-extension"
import {
  installationBlocked,
  type InstallationBlockedState,
  type InstallationIntent,
  type InstallationLanguage,
  type InstallationOperations,
  type InstallationResult,
} from "./install-actions-state"

export interface ConfigExtensionInstallActionsProps extends InstallationBlockedState {
  /** Omit item to render the list-level Install button. */
  item?: Pick<ExtensionInfo, "id" | "source">
  operations: InstallationOperations
  language: InstallationLanguage
  connection: () => unknown
  onResult?: (result: InstallationResult) => void
  /** Injection seam for embedders; production defaults to useDialog. */
  showInstallation?: (intent: InstallationIntent) => void
}

/** Controlled companion to the existing toggle/settings controls; never owns or resets their dirty state. */
export function ConfigExtensionInstallActions(props: ConfigExtensionInstallActionsProps) {
  const dialog = props.showInstallation ? undefined : useDialog()
  const blocked = () => installationBlocked(props)
  const updateBlocked = () => blocked() || props.item?.source?.type === "path"
  const open = (intent: InstallationIntent) => {
    if (blocked() || (intent.kind === "update" && updateBlocked())) return
    if (props.showInstallation) return props.showInstallation(intent)
    let closed: (() => void) | undefined
    dialog!.show(
      () => (
        <DialogInstallExtension
          intent={intent}
          operations={props.operations}
          language={props.language}
          connection={props.connection}
          enabled={props.enabled}
          busy={props.busy}
          dirty={props.dirty}
          saving={props.saving}
          blocked={props.blocked}
          onResult={props.onResult}
          registerClose={(callback) => {
            closed = callback
          }}
        />
      ),
      () => closed?.(),
    )
  }
  return (
    <div class="flex flex-wrap items-center gap-2" data-extension-install-actions={props.item?.id ?? "install"}>
      <Show
        when={props.item}
        fallback={
          <Button data-action="extension-install-open" disabled={blocked()} onClick={() => open({ kind: "install" })}>
            {props.language.t("config.extensions.install.title")}
          </Button>
        }
      >
        {(item) => (
          <>
            <Button
              data-action="extension-update-open"
              disabled={updateBlocked()}
              onClick={() => open({ kind: "update", id: item().id, source: item().source })}
            >
              {props.language.t("config.extensions.install.update")}
            </Button>
            <Button
              data-action="extension-uninstall-open"
              disabled={blocked()}
              onClick={() => open({ kind: "uninstall", id: item().id })}
            >
              {props.language.t("config.extensions.install.uninstall")}
            </Button>
          </>
        )}
      </Show>
    </div>
  )
}

export type { ExtensionInstallationProps }
