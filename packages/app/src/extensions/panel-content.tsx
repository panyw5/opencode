import { ErrorBoundary, Show, createMemo, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Mark } from "@opencode-ai/ui/logo"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { extensionPanelTitle, getExtensionPanel } from "./panel-registry"
import { parseExtensionPanelTab } from "./panel-tab"

// Panel state is kept in memory, keyed by tab value and seeded from the tab's
// query params. Rewriting the tab value would change the tab identity (and
// remount the keyed panel), so persisting state is left to the extension host.
const [panelState, setPanelState] = createStore<Record<string, Record<string, string>>>({})

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function ExtensionPanelIcon(props: { icon?: string; class?: string }): JSX.Element {
  const asset = () => !!props.icon && /[:/]/.test(props.icon)
  return (
    <Show
      when={asset()}
      fallback={<Icon name={(props.icon ?? "layout-right") as IconName} size="small" class={props.class} />}
    >
      <img src={props.icon} alt="" class={`size-4 shrink-0 ${props.class ?? ""}`} />
    </Show>
  )
}

export function ExtensionPanelVisual(props: { tab: string }): JSX.Element {
  const parsed = createMemo(() => parseExtensionPanelTab(props.tab))
  const entry = createMemo(() => {
    const value = parsed()
    if (!value) return
    return getExtensionPanel(value.extensionID, value.panelID)
  })
  const title = createMemo(() => {
    const value = entry()
    if (value) return extensionPanelTitle(value)
    return parsed()?.panelID ?? props.tab
  })
  return (
    <div class="flex items-center gap-x-1.5 min-w-0" data-extension={parsed()?.extensionID}>
      <ExtensionPanelIcon icon={entry()?.icon} class="shrink-0" />
      <span class="truncate text-12-medium">{title()}</span>
    </div>
  )
}

export function ExtensionPanelContent(props: { tab: string }): JSX.Element {
  const language = useLanguage()
  const sdk = useSDK()
  const { params, tabs } = useSessionLayout()
  const parsed = createMemo(() => parseExtensionPanelTab(props.tab))
  const entry = createMemo(() => {
    const value = parsed()
    if (!value) return
    return getExtensionPanel(value.extensionID, value.panelID)
  })

  const state = () => panelState[props.tab] ?? parsed()?.state ?? {}
  const panelProps = {
    state,
    setState(patch: Record<string, string>) {
      setPanelState(props.tab, { ...state(), ...patch })
    },
    close() {
      console.debug(`[extension-panel] close tab=${props.tab}`)
      tabs().close(props.tab)
    },
    directory: () => sdk.directory,
    sessionID: () => params.id,
  }

  return (
    <Tabs.Content value={props.tab} class="relative h-full">
      <Show
        when={entry()}
        fallback={
          <div class="relative pt-2 h-full min-h-0 overflow-hidden">
            <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
              <Mark class="w-14 opacity-10" />
              <div class="flex flex-col gap-1 max-w-64">
                <div class="text-14-medium text-text-strong">
                  {language.t("session.extensionTab.unavailable.title")}
                </div>
                <div class="text-13-regular text-text-weak">
                  {language.t("session.extensionTab.unavailable.description")}
                </div>
              </div>
            </div>
          </div>
        }
      >
        {(value) => (
          <div data-extension={value().extensionID} class="oc-extension-root relative h-full min-h-0 overflow-hidden">
            <ErrorBoundary
              fallback={(error, reset) => {
                console.error(`[extension-panel] render failed tab=${props.tab} err=${errorText(error)}`)
                return (
                  <div class="h-full px-6 flex flex-col items-center justify-center text-center gap-3">
                    <div class="text-13-regular text-text-weak break-words max-w-96">{errorText(error)}</div>
                    <Button variant="secondary" size="small" onClick={reset}>
                      {language.t("ui.presentation.retry")}
                    </Button>
                  </div>
                )
              }}
            >
              <Dynamic component={value().component} {...panelProps} />
            </ErrorBoundary>
          </div>
        )}
      </Show>
    </Tabs.Content>
  )
}
