import type { ProjectTask } from "@opencode-ai/sdk/v2/client"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"

export function SessionProjectTaskMount() {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const sync = useSync()
  const { params } = useSessionLayout()
  const [state, setState] = createStore({
    open: false,
    loading: false,
    pending: false,
    tasks: [] as ProjectTask[],
    error: "",
  })

  const sessionID = createMemo(() => params.id)
  const session = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return sync.session.get(id)
  })
  const mountedID = createMemo(() => session()?.mountedTaskID)
  const mountedTitle = createMemo(() => {
    const id = mountedID()
    if (!id) return undefined
    return state.tasks.find((task) => task.id === id)?.title
  })

  async function loadTasks() {
    setState({ loading: true, error: "" })
    try {
      const result = await sdk.client.projectTask.list({})
      setState({ tasks: (result.data ?? []).filter((task) => task.status !== "archived"), error: "" })
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("loading", false)
    }
  }

  createEffect(() => {
    if (!state.open) return
    void loadTasks()
  })

  async function mount(taskID: string) {
    const id = sessionID()
    if (!id) return
    setState({ pending: true, error: "" })
    try {
      await sdk.client.projectTask.mount({
        sessionID: id,
        projectTaskMountInput: { taskID },
      })
      setState("open", false)
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setState("pending", false)
    }
  }

  async function unmount() {
    const id = sessionID()
    if (!id) return
    setState({ pending: true, error: "" })
    try {
      await sdk.client.projectTask.unmount({ sessionID: id })
      setState("open", false)
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setState("pending", false)
    }
  }

  return (
    <Show when={sessionID()}>
      <DropdownMenu
        gutter={4}
        placement="bottom-end"
        open={state.open}
        onOpenChange={(open) => setState("open", open)}
      >
        <Tooltip placement="bottom" value={language.t("projectTask.mount.tooltip")}>
          <DropdownMenu.Trigger
            as={IconButton}
            icon="checklist"
            variant="ghost"
            class="rounded-md"
            classList={{
              "bg-surface-raised-base-active": !!mountedID(),
            }}
            aria-label={
              mountedTitle()
                ? language.t("projectTask.mount.mounted", { title: mountedTitle()! })
                : language.t("projectTask.mount.none")
            }
          />
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="min-w-56 max-w-72">
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="!px-2 !py-1">
                {language.t("projectTask.mount.menuTitle")}
              </DropdownMenu.GroupLabel>
              <Show when={state.loading}>
                <div class="flex items-center gap-2 px-2 py-2 text-12-regular text-text-weak">
                  <Spinner class="size-3.5" />
                  {language.t("projectTask.loading")}
                </div>
              </Show>
              <Show when={state.error}>
                <div class="px-2 py-2 text-12-regular text-text-danger">{state.error}</div>
              </Show>
              <Show when={!state.loading && state.tasks.length === 0}>
                <div class="px-2 py-2 text-12-regular text-text-weak">{language.t("projectTask.mount.empty")}</div>
              </Show>
              <For each={state.tasks}>
                {(task) => (
                  <DropdownMenu.Item
                    disabled={state.pending}
                    class="gap-2"
                    onSelect={() => void mount(task.id)}
                  >
                    <Icon
                      name={mountedID() === task.id ? "check-small" : "checklist"}
                      size="small"
                      class={mountedID() === task.id ? "text-icon-brand-base" : "text-icon-weak"}
                    />
                    <div class="min-w-0 flex-1">
                      <DropdownMenu.ItemLabel class="truncate">{task.title}</DropdownMenu.ItemLabel>
                      <div class="truncate text-11-regular text-text-weaker">
                        {task.progress.total > 0
                          ? `${task.progress.completed}/${task.progress.total}`
                          : task.status}
                      </div>
                    </div>
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Group>
            <Show when={mountedID()}>
              <DropdownMenu.Separator />
              <DropdownMenu.Item disabled={state.pending} onSelect={() => void unmount()}>
                <Icon name="close" size="small" class="text-icon-weak" />
                <DropdownMenu.ItemLabel>{language.t("projectTask.mount.unmount")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
