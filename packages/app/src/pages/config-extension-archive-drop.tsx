import { useDialog } from "@opencode-ai/ui/context/dialog"
import { onCleanup, onMount } from "solid-js"
import { DialogInstallExtension } from "../components/dialog-install-extension"
import { usePlatform } from "../context/platform"
import { useServer } from "../context/server"
import { useLanguage } from "../context/language"
import { useGlobalSDK } from "../context/global-sdk"
import { useExtensionHost } from "../extensions/host"
import { createLocalInstallationOperations, registerArchiveDropHandler } from "../extensions/install-local"

const ARCHIVE_PATTERN = /\.tgz$/i

/**
 * Desktop-only drop target for the Extensions config section: dropping .tgz
 * archives opens the install dialog in local-archive mode. The layout-level
 * drop handler consults the registered consumer before routing files to the
 * composer, so this component claims the drop only while mounted.
 */
export function ExtensionArchiveDropTarget() {
  const platform = usePlatform()
  const server = useServer()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const extensionHost = useExtensionHost()
  const dialog = useDialog()

  const supported = () =>
    server.current?.type === "sidecar" &&
    server.current.variant === "base" &&
    typeof platform.extensionArchiveOp === "function" &&
    typeof platform.extensionArchiveDigest === "function"

  onMount(() => {
    // The connection may become local while this section stays mounted.
    console.info("[extension-archive-drop] registered; support checked per drop")
    let closed: (() => void) | undefined
    const unregister = registerArchiveDropHandler((paths) => {
      if (!supported() || paths.length === 0 || !paths.every((path) => ARCHIVE_PATTERN.test(path))) return false
      const path = paths[0]!
      let registered = false
      dialog.show(
        () => (
          <DialogInstallExtension
            intent={{ kind: "install", localArchive: { path } }}
            operations={createLocalInstallationOperations(
              (op, payload) => platform.extensionArchiveOp!(op, payload),
              () => extensionHost.refresh({ strict: true }),
            )}
            language={language}
            connection={() => globalSDK.client}
            localArchiveBridge={{
              digest: (digestPath) => platform.extensionArchiveDigest!(digestPath),
            }}
            enabled={extensionHost.enabled()}
            busy={extensionHost.mutating("@installation")}
            registerClose={(callback) => {
              closed = callback
              registered = true
            }}
          />
        ),
        () => closed?.(),
      )
      void registered
      return true
    })
    onCleanup(unregister)
  })

  // Visible anchor for tests and debugging; the drop itself is claimed via
  // the registered handler, not DOM events.
  return <div data-extension-archive-drop="" hidden aria-hidden="true" />
}
