import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ExtensionCard, ExtensionContributions } from "../components/extension-card"
import { ExtensionRuntimeStatus } from "../components/extension-runtime-status"
import { installationSourceLabel } from "./install-actions-state"
import { useLanguage } from "@/context/language"
import { useExtensionHost } from "@/extensions/host"
import type { ExtensionInfo } from "@/extensions/types"
import { ConfigExtensionActions } from "./config-extension-actions"
import { useGlobalSDK } from "@/context/global-sdk"
import { ConfigExtensionInstallActions } from "./config-extension-install-actions"
import { ConfigExtensionSettings } from "./config-extension-settings"
import { isKnownExtensionPermission } from "@/extensions/permissions"
import { extensionWarningLabel } from "@/extensions/warnings"

// The config page keys this detail by extension id.
export function ConfigExtensionDetail(props: { item: ExtensionInfo }) {
  const language = useLanguage()
  const host = useExtensionHost()
  const globalSDK = useGlobalSDK()
  const [form, setForm] = createStore({ dirty: false, saving: false })
  return (
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-4" data-extension-detail={props.item.id}>
      <ConfigExtensionActions item={props.item} dirty={form.dirty} saving={form.saving}>
        <ConfigExtensionInstallActions
          item={props.item}
          operations={host}
          language={language}
          connection={() => globalSDK.client}
          enabled={host.enabled()}
          busy={host.mutating(props.item.id)}
          dirty={form.dirty}
          saving={form.saving}
        />
      </ConfigExtensionActions>
      <ExtensionRuntimeStatus
        item={props.item}
        retry={host.retry}
        connection={() => globalSDK.client}
        disabled={!host.enabled() || host.mutating(props.item.id) || form.dirty || form.saving}
      />
      <Show when={props.item.warnings?.length}>
        <ExtensionCard title={language.t("config.extensions.warnings.title")}>
          <For each={props.item.warnings}>
            {(warning) => {
              const label = extensionWarningLabel(warning)
              return (
                <p class="text-13-regular text-text-base" data-extension-warning>
                  {label ? language.t(label.key, label.params) : warning}
                </p>
              )
            }}
          </For>
        </ExtensionCard>
      </Show>
      <Show when={props.item.source}>
        {(source) => (
          <ExtensionCard title={language.t("config.extensions.install.source")}>
            <p class="break-all font-mono text-12-regular text-text-base">{installationSourceLabel(source())}</p>
          </ExtensionCard>
        )}
      </Show>
      <div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <ExtensionCard title={language.t("config.extensions.install.permissions")}>
          <Show
            when={props.item.permissions?.length}
            fallback={<p class="text-13-regular text-text-weak">{language.t("config.extensions.install.none")}</p>}
          >
            <ul class="flex flex-wrap gap-2">
              <For each={props.item.permissions}>
                {(permission) => (
                  <li class="break-all rounded-md bg-surface-secondary px-2 py-1 font-mono text-12-regular text-text-base">
                    {permission}
                    <Show when={!isKnownExtensionPermission(permission)}>
                      <span class="text-text-weak">{` (${language.t("config.extensions.install.permissionUnknown")})`}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <p class="text-12-regular text-text-weak">{language.t("config.extensions.install.permissionsNote")}</p>
          </Show>
        </ExtensionCard>
        <ExtensionCard title={language.t("config.extensions.install.contributes")}>
          <ExtensionContributions contributes={props.item.contributes} t={language.t} />
        </ExtensionCard>
      </div>
      <ExtensionCard title={language.t("config.extensions.install.settings")}>
        <Show
          when={Object.keys(props.item.contributes.settings ?? {}).length > 0}
          fallback={<p class="text-13-regular text-text-weak">{language.t("config.extensions.noSettings")}</p>}
        >
          <ConfigExtensionSettings
            item={props.item}
            hideHeading
            disabled={host.mutating(props.item.id)}
            onStateChange={setForm}
          />
        </Show>
      </ExtensionCard>
    </div>
  )
}
