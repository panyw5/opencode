import { expect, mock, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import "./solid-form-loader"
import { takeArchiveDrop } from "../../src/extensions/install-local"

const [current, setCurrent] = createSignal<{ type: string; variant?: string }>({ type: "http" })
let opened = 0
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: () => {
      opened++
    },
  }),
}))
mock.module("../../src/context/platform", () => ({
  usePlatform: () => ({ extensionArchiveOp() {}, extensionArchiveDigest() {} }),
}))
mock.module("../../src/context/server", () => ({
  useServer: () => ({
    get current() {
      return current()
    },
  }),
}))
mock.module("../../src/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("../../src/context/global-sdk", () => ({ useGlobalSDK: () => ({ client: {} }) }))
mock.module("../../src/extensions/host", () => ({
  useExtensionHost: () => ({ enabled: () => true, mutating: () => false, refresh: async () => {} }),
}))
mock.module("../../src/components/dialog-install-extension", () => ({ DialogInstallExtension: () => null }))
const { ExtensionArchiveDropTarget } = await import("../../src/pages/config-extension-archive-drop")

test("mounted remote drop target accepts archives after switching to local without remount", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(() => createComponent(ExtensionArchiveDropTarget, {}), root)
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    expect(takeArchiveDrop(["/tmp/test.tgz"])).toBe(false)
    expect(opened).toBe(0)
    setCurrent({ type: "sidecar", variant: "base" })
    expect(takeArchiveDrop(["/tmp/test.tgz"])).toBe(true)
    expect(opened).toBe(1)
    setCurrent({ type: "http" })
    expect(takeArchiveDrop(["/tmp/test.tgz"])).toBe(false)
    setCurrent({ type: "sidecar", variant: "extra" })
    expect(takeArchiveDrop(["/tmp/test.tgz"])).toBe(false)
  } finally {
    dispose()
    root.remove()
  }
  expect(takeArchiveDrop(["/tmp/test.tgz"])).toBe(false)
})
