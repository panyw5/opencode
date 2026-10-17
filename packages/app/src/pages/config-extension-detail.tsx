import { Show, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useExtensionHost } from "@/extensions/host"
import type { ExtensionInfo } from "@/extensions/types"
import { ConfigExtensionActions } from "./config-extension-actions"
import { useGlobalSDK } from "@/context/global-sdk"
import { ConfigExtensionInstallActions } from "./config-extension-install-actions"
import { ConfigExtensionSettings } from "./config-extension-settings"

// The config page keys this detail by extension id.
export function ConfigExtensionDetail(props: { item: ExtensionInfo }) {
  const language = useLanguage()
  const host = useExtensionHost()
  const globalSDK = useGlobalSDK()
  const [form, setForm] = createSignal({ dirty: false, saving: false })
  return (
    <div class="mx-auto w-full max-w-5xl">
      <ConfigExtensionActions item={props.item} dirty={form().dirty} saving={form().saving} />
      <div class="mb-4">
        <ConfigExtensionInstallActions
          item={props.item}
          operations={host}
          language={language}
          connection={() => globalSDK.client}
          enabled={host.enabled()}
          busy={host.mutating(props.item.id)}
          dirty={form().dirty}
          saving={form().saving}
        />
      </div>
      <Show
        when={Object.keys(props.item.contributes.settings ?? {}).length > 0}
        fallback={<p class="text-13-regular text-text-weak">{language.t("config.extensions.noSettings")}</p>}
      >
        <ConfigExtensionSettings item={props.item} disabled={host.mutating(props.item.id)} onStateChange={setForm} />
      </Show>
    </div>
  )
}
