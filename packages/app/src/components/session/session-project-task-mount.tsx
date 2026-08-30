import type { ProjectTask, Session } from "@opencode-ai/sdk/v2/client"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  pendingProjectTaskMount,
  setPendingProjectTaskMount,
} from "@/components/session/pending-project-task-mount"
import { Binary } from "@opencode-ai/core/util/binary"

export function SessionProjectTaskMount(props: {
  /** Compact icon trigger (header) vs full row for status panel. */
  variant?: "icon" | "panel"
}) {
  const variant = () => props.variant ?? "icon"
  // Directory-bound client so project-task APIs resolve the same project as the session.
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
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
  const [triggerWidth, setTriggerWidth] = createSignal(0)
  let triggerEl: HTMLButtonElement | undefined
  let taskRequest = 0

  const measureTrigger = () => {
    if (!triggerEl) return
    setTriggerWidth(Math.round(triggerEl.getBoundingClientRect().width))
  }

  const sessionID = createMemo(() => params.id)
  const directory = createMemo(() => sdk.directory)
  const session = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return sync.session.get(id)
  })
  // Existing session: server state. New session: local pending selection.
  const pending = createMemo(() => pendingProjectTaskMount(directory()))
  const mountedID = createMemo(() => session()?.mountedTaskID ?? pending().taskID)
  // Product default: inject ON. Missing/undefined → true (legacy events / new session).
  const injectContext = createMemo(() => {
    if (!sessionID()) return pending().inject
    const value = session()?.injectTaskContext
    if (value === undefined || value === null) return true
    return !!value
  })
  const mountedTitle = createMemo(() => {
    const id = mountedID()
    if (!id) return undefined
    return state.tasks.find((task) => task.id === id)?.title
  })

  /** Optimistic local patch so the checkbox reflects mount/inject without waiting for SSE. */
  const patchSession = (sessionID: string, patch: Partial<Session>) => {
    sync.set(
      produce((draft) => {
        const match = Binary.search(draft.session as Session[], sessionID, (s) => s.id)
        if (!match.found) return
        const current = draft.session[match.index]
        if (!current) return
        draft.session[match.index] = { ...current, ...patch }
      }),
    )
  }

  async function loadTasks(options?: { silent?: boolean }) {
    const current = ++taskRequest
    if (!options?.silent) setState({ loading: true, error: "" })
    try {
      const result = await sdk.client.projectTask.list({})
      if (current !== taskRequest) return
      setState({
        tasks: (result.data ?? []).filter((task) => task.status !== "archived"),
        error: "",
      })
    } catch (error) {
      if (current !== taskRequest) return
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (current !== taskRequest) return
      setState("loading", false)
    }
  }

  // Keep list warm so dashboard create/update is visible without reopening.
  createEffect(() => {
    sessionID()
    directory()
    void loadTasks({ silent: true })
  })

  createEffect(() => {
    if (!state.open) return
    void loadTasks()
  })

  const stop = globalSDK.listenAll((event) => {
    const type = event.details.type
    const properties =
      "properties" in event.details
        ? (event.details.properties as { projectID?: string; info?: { id?: string } } | undefined)
        : undefined
    const sameProject = !properties?.projectID || properties.projectID === session()?.projectID
    const sameSession = !properties?.info?.id || properties.info.id === sessionID()
    if ((type.startsWith("project-task.") && sameProject) || (type === "session.updated" && sameSession) || type === "sync") {
      void loadTasks({ silent: true })
    }
  })
  onCleanup(stop)

  async function mount(taskID: string) {
    const id = sessionID()
    if (!id) {
      // New session: stash selection; inject defaults ON unless user already toggled it off.
      const inject = pending().inject
      setPendingProjectTaskMount(directory(), { taskID, inject })
      console.log(`[project-task-mount] pending select task=${taskID} inject=${inject} directory=${directory()}`)
      setState("open", false)
      return
    }
    setState({ pending: true, error: "" })
    try {
      await sdk.client.projectTask.mount({
        sessionID: id,
        projectTaskMountInput: { taskID },
      })
      // Mount enables inject server-side; patch local store so the checkbox is checked immediately.
      patchSession(id, { mountedTaskID: taskID, injectTaskContext: true })
      console.log(`[project-task-mount] mounted task=${taskID} session=${id} inject=true`)
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
    if (!id) {
      setPendingProjectTaskMount(directory(), { taskID: undefined })
      console.log(`[project-task-mount] pending clear directory=${directory()}`)
      setState("open", false)
      return
    }
    setState({ pending: true, error: "" })
    try {
      await sdk.client.projectTask.unmount({ sessionID: id })
      patchSession(id, { mountedTaskID: undefined })
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

  async function setInject(enabled: boolean) {
    const id = sessionID()
    if (!id) {
      setPendingProjectTaskMount(directory(), { inject: enabled })
      console.log(`[project-task-mount] pending inject=${enabled} directory=${directory()}`)
      return
    }
    setState({ pending: true, error: "" })
    try {
      await sdk.client.session.update({
        sessionID: id,
        injectTaskContext: enabled,
      })
      patchSession(id, { injectTaskContext: enabled })
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

  const menu = (
    <DropdownMenu
      gutter={4}
      placement="bottom-start"
      open={state.open}
      onOpenChange={(open) => {
        if (open) measureTrigger()
        setState("open", open)
      }}
    >
      <DropdownMenu.Trigger
        as="button"
        type="button"
        ref={(el: HTMLButtonElement) => {
          triggerEl = el
          measureTrigger()
        }}
        class={
          variant() === "panel"
            ? "flex w-full items-center justify-between gap-2 rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-left text-13-regular text-text-strong transition-colors hover:bg-surface-base-hover"
            : "inline-flex items-center gap-1 rounded-md border border-border-weak-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-strong transition-colors hover:bg-surface-raised-base-hover data-[expanded]:bg-surface-raised-base-active"
        }
        classList={{
          "border-border-brand-base": !!mountedID(),
        }}
        aria-label={
          mountedTitle()
            ? language.t("projectTask.mount.mounted", { title: mountedTitle()! })
            : language.t("projectTask.mount.none")
        }
      >
        <span class="flex min-w-0 items-center gap-2">
          <Icon name="checklist" size="small" class={mountedID() ? "text-icon-brand-base" : "text-icon-weak"} />
          <span class="min-w-0 truncate">
            {mountedTitle() ?? language.t("projectTask.mount.none")}
          </span>
        </span>
        <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="box-border max-w-none"
          style={{
            width: triggerWidth() > 0 ? `${triggerWidth()}px` : undefined,
            "min-width": triggerWidth() > 0 ? `${triggerWidth()}px` : "14rem",
          }}
        >
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
                <DropdownMenu.Item disabled={state.pending} class="gap-2" onSelect={() => void mount(task.id)}>
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
  )

  return (
    <Show when={variant() === "panel"} fallback={menu}>
      <div data-component="session-project-task-mount" class="flex flex-col gap-2 px-3 py-3">
        <div class="text-13-medium text-text-strong">{language.t("projectTask.mount.sectionTitle")}</div>
        {menu}
        <label class="mt-1 flex cursor-pointer items-start gap-2 rounded-lg border border-border-weak-base bg-background-base px-3 py-2">
          <input
            type="checkbox"
            class="mt-0.5"
            checked={injectContext()}
            disabled={state.pending || !mountedID()}
            onChange={(event) => void setInject(event.currentTarget.checked)}
          />
          <span class="min-w-0">
            <span class="block text-12-medium text-text-strong">{language.t("projectTask.inject.title")}</span>
            <span class="block text-11-regular text-text-weak">{language.t("projectTask.inject.hint")}</span>
          </span>
        </label>
      </div>
    </Show>
  )
}
