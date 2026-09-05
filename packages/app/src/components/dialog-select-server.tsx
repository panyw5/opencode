import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { useMutation } from "@tanstack/solid-query"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show, For } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import type { SshServersState } from "@/ssh/types"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"

const DEFAULT_USERNAME = "opencode"

interface ServerFormProps {
  value: string
  name: string
  username: string
  password: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  onChange: (value: string) => void
  onNameChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
}

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultUrlActions] = createResource(
    async () => {
      try {
        const key = await platform.getDefaultServer?.()
        if (!key) return null
        return key
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  const setDefault = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultUrlActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return { defaultKey, canDefault, setDefault }
}

function useServerPreview() {
  const checkServerHealth = useCheckServerHealth()

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = async (
    value: string,
    username: string,
    password: string,
    setStatus: (value: boolean | undefined) => void,
  ) => {
    setStatus(undefined)
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const http: ServerConnection.HttpBase = { url: normalized }
    if (username) http.username = username
    if (password) http.password = password
    const result = await checkServerHealth(http)
    setStatus(result.healthy)
  }

  return { previewStatus }
}

function ServerForm(props: ServerFormProps) {
  const language = useLanguage()
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      props.onBack()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    props.onSubmit()
  }

  return (
    <div class="px-5">
      <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
        <div class="flex-1 min-w-0 [&_[data-slot=input-wrapper]]:relative">
          <TextField
            type="text"
            label={language.t("dialog.server.add.url")}
            placeholder={props.placeholder}
            value={props.value}
            autofocus
            validationState={props.error ? "invalid" : "valid"}
            error={props.error}
            disabled={props.busy}
            onChange={props.onChange}
            onKeyDown={keyDown}
          />
        </div>
        <TextField
          type="text"
          label={language.t("dialog.server.add.name")}
          placeholder={language.t("dialog.server.add.namePlaceholder")}
          value={props.name}
          disabled={props.busy}
          onChange={props.onNameChange}
          onKeyDown={keyDown}
        />
        <div class="grid grid-cols-2 gap-2 min-w-0">
          <TextField
            type="text"
            label={language.t("dialog.server.add.username")}
            placeholder={language.t("dialog.server.add.usernamePlaceholder")}
            value={props.username}
            disabled={props.busy}
            onChange={props.onUsernameChange}
            onKeyDown={keyDown}
          />
          <TextField
            type="password"
            label={language.t("dialog.server.add.password")}
            placeholder={language.t("dialog.server.add.passwordPlaceholder")}
            value={props.password}
            disabled={props.busy}
            onChange={props.onPasswordChange}
            onKeyDown={keyDown}
          />
        </div>
      </div>
    </div>
  )
}

export function DialogSelectServer() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const { defaultKey, canDefault, setDefault } = useDefaultServer()
  const { previewStatus } = useServerPreview()
  const checkServerHealth = useCheckServerHealth()
  const [store, setStore] = createStore({
    status: {} as Record<ServerConnection.Key, ServerHealth | undefined>,
    addServer: {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
    },
    addSsh: {
      target: "",
      error: "",
      showForm: false,
    },
    editServer: {
      id: undefined as string | undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined as boolean | undefined,
    },
  })

  const resetAdd = () => {
    setStore("addServer", {
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined,
    })
  }
  const resetAddSsh = () => {
    setStore("addSsh", { target: "", error: "", showForm: false })
  }
  const resetEdit = () => {
    setStore("editServer", {
      id: undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined,
    })
  }

  const addMutation = useMutation(() => ({
    mutationFn: async (value: string) => {
      const normalized = normalizeServerUrl(value)
      if (!normalized) {
        resetAdd()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        http: { url: normalized },
      }
      if (store.addServer.name.trim()) conn.displayName = store.addServer.name.trim()
      if (store.addServer.password) conn.http.password = store.addServer.password
      if (store.addServer.password && store.addServer.username) conn.http.username = store.addServer.username
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("addServer", { error: language.t("dialog.server.add.error") })
        return
      }

      resetAdd()
      await select(conn, true)
    },
  }))

  const editMutation = useMutation(() => ({
    mutationFn: async (input: { original: ServerConnection.Any; value: string }) => {
      if (input.original.type !== "http") return
      const normalized = normalizeServerUrl(input.value)
      if (!normalized) {
        resetEdit()
        return
      }

      const name = store.editServer.name.trim() || undefined
      const username = store.editServer.username || undefined
      const password = store.editServer.password || undefined
      const existingName = input.original.displayName
      if (
        normalized === input.original.http.url &&
        name === existingName &&
        username === input.original.http.username &&
        password === input.original.http.password
      ) {
        resetEdit()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        displayName: name,
        http: { url: normalized, username, password },
      }
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("editServer", { error: language.t("dialog.server.add.error") })
        return
      }
      if (normalized === input.original.http.url) {
        server.add(conn)
      } else {
        replaceServer(input.original, conn)
      }

      resetEdit()
    },
  }))

  const replaceServer = (original: ServerConnection.Http, next: ServerConnection.Http) => {
    const active = server.key
    const newConn = server.add(next)
    if (!newConn) return
    const nextActive = active === ServerConnection.key(original) ? ServerConnection.key(newConn) : active
    if (nextActive) server.setActive(nextActive)
    server.remove(ServerConnection.key(original))
  }

  // SSH remote hosts (desktop only): mirror the main-process sidecar state so
  // hosts can be managed even before they become ready connections.
  const sshApi = () => platform.sshServers
  const [sshState, setSshState] = createSignal<SshServersState | undefined>(undefined)
  createEffect(() => {
    const api = sshApi()
    if (!api) return
    void api
      .getState()
      .then(setSshState)
      .catch(() => undefined)
    const unsub = api.subscribe((event) => setSshState(event.state))
    onCleanup(unsub)
  })

  const sshMutation = useMutation(() => ({
    mutationFn: async (input: { action: "add" | "remove" | "start" | "install"; target?: string; id?: string }) => {
      const api = sshApi()
      if (!api) return
      if (input.action === "add") {
        await api.addServer(input.target!.trim(), true)
        return
      }
      if (input.action === "remove") {
        await api.removeServer(input.id!)
        return
      }
      if (input.action === "start") {
        await api.startServer(input.id!)
        return
      }
      await api.installOpencode(input.target!)
    },
    onError: (err) => showRequestError(language, err),
  }))

  const items = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const current = createMemo(() => items().find((x) => ServerConnection.key(x) === server.key) ?? items()[0])

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff = rank(store.status[ServerConnection.key(a)]) - rank(store.status[ServerConnection.key(b)])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function refreshHealth() {
    const results: Record<ServerConnection.Key, ServerHealth> = {}
    await Promise.all(
      items().map(async (conn) => {
        results[ServerConnection.key(conn)] = await checkServerHealth(conn.http)
      }),
    )
    setStore("status", reconcile(results))
  }

  createEffect(() => {
    items()
    refreshHealth()
    const interval = setInterval(refreshHealth, 10_000)
    onCleanup(() => clearInterval(interval))
  })

  async function select(conn: ServerConnection.Any, persist?: boolean) {
    if (!persist && store.status[ServerConnection.key(conn)]?.healthy === false) return
    dialog.close()
    if (persist && conn.type === "http") {
      server.add(conn)
      navigate("/")
      return
    }
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(conn)))
  }

  const handleAddChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { url: value, error: "" })
    void previewStatus(value, store.addServer.username, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddNameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { name: value, error: "" })
  }

  const handleAddUsernameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { username: value, error: "" })
    void previewStatus(store.addServer.url, value, store.addServer.password, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleAddPasswordChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { password: value, error: "" })
    void previewStatus(store.addServer.url, store.addServer.username, value, (next) =>
      setStore("addServer", { status: next }),
    )
  }

  const handleEditChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { value, error: "" })
    void previewStatus(value, store.editServer.username, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditNameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { name: value, error: "" })
  }

  const handleEditUsernameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { username: value, error: "" })
    void previewStatus(store.editServer.value, value, store.editServer.password, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const handleEditPasswordChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { password: value, error: "" })
    void previewStatus(store.editServer.value, store.editServer.username, value, (next) =>
      setStore("editServer", { status: next }),
    )
  }

  const mode = createMemo<"list" | "add" | "add-ssh" | "edit">(() => {
    if (store.editServer.id) return "edit"
    if (store.addSsh.showForm) return "add-ssh"
    if (store.addServer.showForm) return "add"
    return "list"
  })

  const editing = createMemo(() => {
    if (!store.editServer.id) return
    return items().find((x) => x.type === "http" && x.http.url === store.editServer.id)
  })

  const resetForm = () => {
    resetAdd()
    resetAddSsh()
    resetEdit()
  }

  const startAdd = () => {
    resetEdit()
    setStore("addSsh", { showForm: false })
    setStore("addServer", {
      showForm: true,
      url: "",
      name: "",
      username: DEFAULT_USERNAME,
      password: "",
      error: "",
      status: undefined,
    })
  }

  const startAddSsh = () => {
    resetEdit()
    setStore("addServer", { showForm: false })
    setStore("addSsh", { showForm: true, target: "", error: "" })
  }

  const startEdit = (conn: ServerConnection.Http) => {
    resetAdd()
    setStore("editServer", {
      id: conn.http.url,
      value: conn.http.url,
      name: conn.displayName ?? "",
      username: conn.http.username ?? "",
      password: conn.http.password ?? "",
      error: "",
      status: store.status[ServerConnection.key(conn)]?.healthy,
    })
  }

  const submitForm = () => {
    if (mode() === "add-ssh") {
      if (sshMutation.isPending) return
      const target = store.addSsh.target.trim()
      if (!target || /\s/.test(target)) {
        setStore("addSsh", { error: language.t("dialog.server.addSsh.error") })
        return
      }
      setStore("addSsh", { error: "" })
      sshMutation
        .mutateAsync({ action: "add", target })
        .then((result) => {
          if (result === undefined) return
          resetAddSsh()
        })
        .catch(() => undefined)
      return
    }
    if (mode() === "add") {
      if (addMutation.isPending) return
      setStore("addServer", { error: "" })
      addMutation.mutate(store.addServer.url)
      return
    }
    const original = editing()
    if (!original) return
    if (editMutation.isPending) return
    setStore("editServer", { error: "" })
    editMutation.mutate({ original, value: store.editServer.value })
  }

  const isFormMode = createMemo(() => mode() !== "list")
  const isAddMode = createMemo(() => mode() === "add")
  const isAddSshMode = createMemo(() => mode() === "add-ssh")
  const formBusy = createMemo(() =>
    isAddSshMode() ? sshMutation.isPending : isAddMode() ? addMutation.isPending : editMutation.isPending,
  )

  const formTitle = createMemo(() => {
    if (!isFormMode()) return language.t("dialog.server.title")
    const label = isAddMode()
      ? language.t("dialog.server.add.title")
      : isAddSshMode()
        ? language.t("dialog.server.addSsh.title")
        : language.t("dialog.server.edit.title")
    return (
      <div class="flex items-center gap-2 -ml-2">
        <IconButton icon="arrow-left" variant="ghost" onClick={resetForm} aria-label={language.t("common.goBack")} />
        <span>{label}</span>
      </div>
    )
  })

  createEffect(() => {
    if (!store.editServer.id) return
    if (editing()) return
    resetEdit()
  })

  async function handleRemove(url: ServerConnection.Key) {
    server.remove(url)
    if ((await platform.getDefaultServer?.()) === url) {
      platform.setDefaultServer?.(null)
    }
  }

  return (
    <Dialog title={formTitle()}>
      <div class="flex flex-col gap-2">
        <Show
          when={!isFormMode()}
          fallback={
            <Show
              when={isAddSshMode()}
              fallback={
                <ServerForm
                  value={isAddMode() ? store.addServer.url : store.editServer.value}
                  name={isAddMode() ? store.addServer.name : store.editServer.name}
                  username={isAddMode() ? store.addServer.username : store.editServer.username}
                  password={isAddMode() ? store.addServer.password : store.editServer.password}
                  placeholder={language.t("dialog.server.add.placeholder")}
                  busy={formBusy()}
                  error={isAddMode() ? store.addServer.error : store.editServer.error}
                  status={isAddMode() ? store.addServer.status : store.editServer.status}
                  onChange={isAddMode() ? handleAddChange : handleEditChange}
                  onNameChange={isAddMode() ? handleAddNameChange : handleEditNameChange}
                  onUsernameChange={isAddMode() ? handleAddUsernameChange : handleEditUsernameChange}
                  onPasswordChange={isAddMode() ? handleAddPasswordChange : handleEditPasswordChange}
                  onSubmit={submitForm}
                  onBack={resetForm}
                />
              }
            >
              <div class="px-5">
                <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
                  <div class="[&_[data-slot=input-wrapper]]:relative">
                    <TextField
                      type="text"
                      label={language.t("dialog.server.addSsh.target")}
                      placeholder={language.t("dialog.server.addSsh.targetPlaceholder")}
                      value={store.addSsh.target}
                      autofocus
                      validationState={store.addSsh.error ? "invalid" : "valid"}
                      error={store.addSsh.error}
                      disabled={sshMutation.isPending}
                      onChange={(value) => setStore("addSsh", { target: value, error: "" })}
                      onKeyDown={(event: KeyboardEvent) => {
                        event.stopPropagation()
                        if (event.key === "Escape") {
                          event.preventDefault()
                          resetForm()
                          return
                        }
                        if (event.key !== "Enter" || event.isComposing) return
                        event.preventDefault()
                        submitForm()
                      }}
                    />
                  </div>
                  <p class="text-12-regular text-text-weak m-0">{language.t("dialog.server.addSsh.hint")}</p>
                </div>
              </div>
            </Show>
          }
        >
          <List
            search={{
              placeholder: language.t("dialog.server.search.placeholder"),
              autofocus: false,
            }}
            noInitialSelection
            emptyMessage={language.t("dialog.server.empty")}
            items={sortedItems}
            key={(x) => x.http.url}
            onSelect={(x) => {
              if (x) select(x)
            }}
            divider={true}
            class="px-5 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-viewport]]h-[300px] [&_[data-slot=list-viewport]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
          >
            {(i) => {
              const key = ServerConnection.key(i)
              return (
                <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
                  <div class="flex flex-col h-full items-start w-5">
                    <ServerHealthIndicator health={store.status[key]} />
                  </div>
                  <ServerRow
                    conn={i}
                    dimmed={store.status[key]?.healthy === false}
                    status={store.status[key]}
                    class="flex items-center gap-3 min-w-0 flex-1"
                    badge={
                      <Show when={defaultKey() === ServerConnection.key(i)}>
                        <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs">
                          {language.t("dialog.server.status.default")}
                        </span>
                      </Show>
                    }
                    showCredentials
                  />
                  <div class="flex items-center justify-center gap-4 pl-4">
                    <Show when={ServerConnection.key(current()) === key}>
                      <Icon name="check" class="h-6" />
                    </Show>

                    <Show when={i.type === "http"}>
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
                          onClick={(e: MouseEvent) => e.stopPropagation()}
                          onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content class="mt-1">
                            <DropdownMenu.Item
                              onSelect={() => {
                                if (i.type !== "http") return
                                startEdit(i)
                              }}
                            >
                              <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <Show when={canDefault() && defaultKey() !== key}>
                              <DropdownMenu.Item onSelect={() => setDefault(key)}>
                                <DropdownMenu.ItemLabel>
                                  {language.t("dialog.server.menu.default")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <Show when={canDefault() && defaultKey() === key}>
                              <DropdownMenu.Item onSelect={() => setDefault(null)}>
                                <DropdownMenu.ItemLabel>
                                  {language.t("dialog.server.menu.defaultRemove")}
                                </DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </Show>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item
                              onSelect={() => handleRemove(ServerConnection.key(i))}
                              class="text-text-on-critical-base hover:bg-surface-critical-weak"
                            >
                              <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </Show>
                  </div>
                </div>
              )
            }}
          </List>

          <Show when={sshApi()}>
            <div class="px-5 pb-2 flex flex-col gap-1">
              <span class="text-12-regular text-text-weak uppercase tracking-wide">
                {language.t("dialog.server.ssh.section")}
              </span>
              <div class="flex flex-col bg-surface-base rounded-md overflow-hidden">
                <For each={sshState()?.servers ?? []}>
                  {(item) => {
                    const target = item.config.target
                    const ready = item.runtime.kind === "ready"
                    const busyStarting = item.runtime.kind === "starting"
                    const installing = () =>
                      sshMutation.isPending &&
                      sshMutation.variables?.action === "install" &&
                      sshMutation.variables.target === target
                    const conn = () => server.list.find((x) => x.type === "ssh" && x.host === target)
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-3 w-full min-h-12 pl-3 pr-2 py-2 rounded-md transition-colors text-left hover:bg-surface-base-hover disabled:opacity-60 disabled:pointer-events-none"
                        disabled={!ready || !conn()}
                        onClick={() => {
                          const next = conn()
                          if (ready && next) select(next)
                        }}
                      >
                        <div
                          classList={{
                            "size-1.5 rounded-full shrink-0": true,
                            "bg-icon-success-base": ready,
                            "bg-icon-critical-base": item.runtime.kind === "failed",
                            "bg-icon-warning-base": busyStarting,
                            "bg-border-weak-base": item.runtime.kind === "stopped",
                          }}
                        />
                        <div class="flex-1 min-w-0 flex flex-col">
                          <span class="text-14-regular text-text-strong truncate">{target}</span>
                          <Show when={item.runtime.kind === "failed" ? item.runtime.message : undefined}>
                            {(message) => (
                              <span class="text-12-regular text-text-danger-base truncate">{message()}</span>
                            )}
                          </Show>
                          <Show when={busyStarting}>
                            <span class="text-12-regular text-text-weak truncate">
                              {language.t("dialog.server.ssh.status.starting")}
                            </span>
                          </Show>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <Show when={ready}>
                            <span class="text-12-regular text-text-weak">
                              {language.t("dialog.server.ssh.status.ready")}
                            </span>
                          </Show>
                          <Button
                            variant="secondary"
                            size="small"
                            class="h-7 px-2 py-1"
                            disabled={busyStarting || installing()}
                            onClick={(event: MouseEvent) => {
                              event.stopPropagation()
                              if (busyStarting) return
                              sshMutation.mutate({ action: "start", id: item.config.id })
                            }}
                          >
                            {ready
                              ? language.t("dialog.server.ssh.restart")
                              : language.t("dialog.server.ssh.start")}
                          </Button>
                          <Show when={!ready}>
                            <Button
                              variant="secondary"
                              size="small"
                              class="h-7 px-2 py-1"
                              disabled={installing()}
                              onClick={(event: MouseEvent) => {
                                event.stopPropagation()
                                sshMutation.mutate({ action: "install", target })
                              }}
                            >
                              {installing()
                                ? language.t("dialog.server.add.checking")
                                : language.t("dialog.server.ssh.installOpencode")}
                            </Button>
                          </Show>
                          <IconButton
                            icon="trash"
                            variant="ghost"
                            class="shrink-0 size-7 hover:bg-surface-base-hover"
                            onClick={(event: MouseEvent) => {
                              event.stopPropagation()
                              sshMutation.mutate({ action: "remove", id: item.config.id })
                            }}
                          />
                        </div>
                      </button>
                    )
                  }}
                </For>
                <Show when={(sshState()?.servers ?? []).length === 0}>
                  <div class="px-3 py-3 text-14-regular text-text-weaker">
                    {language.t("dialog.server.ssh.empty")}
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </Show>

        <div class="px-5 pb-5 flex items-center gap-2">
          <Show
            when={isFormMode()}
            fallback={
              <>
                <Button
                  variant="secondary"
                  icon="plus-small"
                  size="large"
                  onClick={startAddSsh}
                  class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
                >
                  {language.t("dialog.server.addSsh.title")}
                </Button>
                <Button
                  variant="secondary"
                  icon="plus-small"
                  size="large"
                  onClick={startAdd}
                  class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
                >
                  {language.t("dialog.server.add.button")}
                </Button>
              </>
            }
          >
            <Button variant="primary" size="large" onClick={submitForm} disabled={formBusy()} class="px-3 py-1.5">
              {formBusy()
                ? language.t("dialog.server.add.checking")
                : isAddSshMode()
                  ? language.t("dialog.server.addSsh.title")
                  : isAddMode()
                    ? language.t("dialog.server.add.button")
                    : language.t("common.save")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
