import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { apps, editor, getOpenPlan, type OpenApp, type OS } from "@/components/session/open-app"
import { Persist, persisted } from "@/utils/persist"

const detectOS = (platform: ReturnType<typeof usePlatform>): OS => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

const dirname = (target: string) => {
  const idx = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))
  return idx < 0 ? "" : target.slice(0, idx)
}

export function OpenInApp(props: { path: string | undefined; logPrefix?: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const os = createMemo(() => detectOS(platform))
  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({ finder: true })
  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [openRequest, setOpenRequest] = createStore({ app: undefined as OpenApp | undefined })
  const appList = createMemo(() => apps(os()))
  const openOptions = createMemo(() => {
    const fileManager =
      os() === "macos"
        ? { label: "session.header.open.finder", icon: "finder" as const }
        : os() === "windows"
          ? { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
          : { label: "session.header.open.fileManager", icon: "finder" as const }
    return [
      { id: "finder", label: language.t(fileManager.label), icon: fileManager.icon },
      ...appList()
        .filter((app) => exists[app.id])
        .map((app) => ({ ...app, label: language.t(app.label) })),
    ] as const
  })
  const current = createMemo(
    () =>
      openOptions().find((option) => option.id === prefs.app) ??
      openOptions()[0] ??
      ({ id: "finder", label: language.t("session.header.open.fileManager"), icon: "finder" } as const),
  )
  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const opening = createMemo(() => openRequest.app !== undefined)
  const prefix = () => props.logPrefix ?? "open-in-app"

  createEffect(() => {
    if (platform.platform !== "desktop" || !platform.checkAppExists) return
    const next = appList()
    console.debug(`[${prefix()}] check-apps-start count=${next.length}`)
    setExists(Object.fromEntries(next.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)
    void Promise.all(
      next.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch((error: unknown) => {
            console.debug(`[${prefix()}] check-app-error app=${app.id} message=${error instanceof Error ? error.message : String(error)}`)
            return false
          })
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => {
      setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>)
      console.debug(`[${prefix()}] check-apps-finish available=${entries.filter(([, ok]) => ok).length}`)
    })
  })

  const openWithApp = (app: OpenApp) => {
    const target = props.path
    console.debug(`[${prefix()}] open-request app=${app} target=${target ?? "<empty>"}`)
    if (opening() || !canOpen() || !platform.openPath || !target) {
      console.debug(`[${prefix()}] open-skipped reason=unavailable-or-empty`)
      return
    }
    if (!openOptions().some((option) => option.id === app)) {
      console.debug(`[${prefix()}] open-skipped reason=invalid-app app=${app}`)
      return
    }
    setPrefs("app", app)
    setOpenRequest("app", app)
    const plan = getOpenPlan(app, openOptions(), !!platform.openInEditor)
    const value = editor(app) ? target : dirname(target) || target
    console.debug(`[${prefix()}] open-plan app=${app} kind=${plan.kind} value=${value}`)
    const task =
      plan.kind === "editor" && platform.openInEditor
        ? platform.openInEditor(plan.editor, value)
        : platform.openPath(value, plan.kind === "path" ? plan.app : undefined)
    console.debug(`[${prefix()}] open-invoke app=${app} value=${value}`)
    Promise.resolve(task)
      .then(() => console.debug(`[${prefix()}] open-success app=${app} value=${value}`))
      .catch((error: unknown) => {
        console.debug(`[${prefix()}] open-error app=${app} message=${error instanceof Error ? error.message : String(error)}`)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        setOpenRequest("app", undefined)
        console.debug(`[${prefix()}] open-finish app=${app}`)
      })
  }

  return (
    <Show when={canOpen()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={Button}
          variant="ghost"
          size="small"
          disabled={opening()}
          class="h-8 rounded-md px-2 gap-1.5 disabled:!cursor-default"
          aria-label={language.t("session.header.open.ariaLabel", { app: current().label })}
        >
          <div class="flex size-4 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-4">
            <Show when={opening()} fallback={<AppIcon id={current().icon} />}>
              <Spinner class="size-3.5" />
            </Show>
          </div>
          <span class="text-12-regular">{language.t("session.header.openIn")}</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="[&_[data-slot=dropdown-menu-radio-item]]:pl-1">
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="!px-1 !py-1">{language.t("session.header.openIn")}</DropdownMenu.GroupLabel>
              <DropdownMenu.RadioGroup class="mt-1" value={current().id}>
                <For each={openOptions()}>
                  {(option) => (
                    <DropdownMenu.RadioItem value={option.id} disabled={opening()} onSelect={() => openWithApp(option.id)}>
                      <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                        <AppIcon id={option.icon} />
                      </div>
                      <DropdownMenu.ItemLabel>{option.label}</DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemIndicator>
                        <Icon name="check-small" size="small" class="text-icon-weak" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )}
                </For>
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
