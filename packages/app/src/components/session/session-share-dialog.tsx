import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Markdown } from "@opencode-ai/ui/markdown"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { resolveThemeVariant, themeToCss } from "@opencode-ai/ui/theme/resolve"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import {
  loadShareMessages,
  shareMarkdown,
  visibleShareMessages,
  selectVisibleShareMessages,
  toggleShareSelection,
  runShareExport,
  type ShareMessage,
} from "./session-share-model"
import { shareHTML, waitForShareRender } from "./session-share-html"
import { SessionShareMessage } from "./session-share-message"
import "./session-share-dialog.css"

export function SessionShareDialog(props: { directory: string; sessionID: string; title: string }) {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const t = language.t
  const theme = useTheme()
  const [state, setState] = createStore({
    title: props.title,
    messages: [] as ShareMessage[],
    selected: [] as string[],
    loading: true,
    error: "",
    busy: "",
    stage: "" as "" | "preparing" | "saving",
    result: "",
    role: "all",
    pane: "selection" as "selection" | "preview",
    theme: "light" as "light" | "dark",
  })
  let preview: HTMLDivElement | undefined
  const paperTheme = createMemo(() => {
    const current = theme.themes()[theme.themeId()]
    return current ? themeToCss(resolveThemeVariant(current[state.theme], state.theme === "dark")) : ""
  })
  const markdown = createMemo(() =>
    shareMarkdown(state.messages, state.selected, state.title, {
      user: t("share.user"),
      assistant: t("share.assistant"),
      omitted: t("share.omitted"),
    }),
  )
  const load = async () => {
    setState({ loading: true, error: "" })
    console.debug(`[session-share] load start sid=${props.sessionID}`)
    try {
      const target = await sdk.client.session
        .get({ directory: props.directory, sessionID: props.sessionID }, { throwOnError: true })
        .then((result) => result.data)
      const messages = await loadShareMessages(
        (input) => sync.session.messages.page(input),
        props.directory,
        props.sessionID,
        target?.revert?.messageID,
      )
      setState({ messages, selected: messages.map((item) => item.id) })
      console.debug(`[session-share] load complete count=${messages.length}`)
    } catch (error) {
      console.error("[session-share] load failed", error)
      setState("error", String(error))
    } finally {
      setState("loading", false)
    }
  }
  onMount(load)
  const exportDocument = async (format: "png" | "pdf" | "markdown") => {
    if (!platform.exportSessionDocument || !state.selected.length || state.busy) return
    setState({ busy: format, stage: "preparing", error: "", result: "" })
    try {
      if (format !== "markdown") {
        if (!preview || !preview.getBoundingClientRect().width) throw new Error(t("share.notReady"))
        console.debug("[session-share] waiting for full render and fonts")
        await waitForShareRender(preview)
      }
      const html = format !== "markdown" && preview ? await shareHTML(preview, state.theme) : undefined
      setState("stage", "saving")
      console.debug(`[session-share] export start format=${format} selected=${state.selected.length}`)
      const result = await runShareExport(state.selected, () =>
        platform.exportSessionDocument!({
          format,
          name: state.title,
          markdown: markdown(),
          html,
          width: format !== "markdown" && preview ? Math.ceil(preview.getBoundingClientRect().width) : undefined,
          theme: state.theme,
        }),
      )
      if (result.status === "failed") throw new Error(result.error)
      setState(
        "result",
        result.status === "cancelled"
          ? t("share.cancelled")
          : result.status === "saved"
            ? t(format === "png" && result.files > 1 ? "share.split" : "share.saved", { count: result.files })
            : "",
      )
    } catch (error) {
      console.error("[session-share] export failed")
      const message = error instanceof Error ? error.message : String(error)
      setState("error", message.includes("32 MiB") ? t("share.tooLarge") : `${t("share.exportError")} ${message.replace(/^Error:\s*/i, "")}`)
    } finally {
      setState({ busy: "", stage: "" })
    }
  }
  return (
    <Dialog
      title={t("share.title")}
      size="x-large"
      class="session-share-dialog"
      containerStyle={{ width: "min(1100px, calc(100vw - 32px))", height: "min(800px, calc(100dvh - 32px))" }}
    >
      <div class="session-share-layout" data-pane={state.pane}>
        <header class="session-share-settings">
          <p class="text-text-weak text-12-regular">{t("share.privacy")}</p>
          <div class="session-share-settings-row">
            <TextField
              class="session-share-title"
              label={t("share.name")}
              value={state.title}
              onChange={(value) => setState("title", value)}
              disabled={!!state.busy}
            />
          </div>
        </header>
        <div class="session-share-pane-switch" role="group" aria-label={t("share.title")}>
          <Button aria-pressed={state.pane === "selection"} onClick={() => setState("pane", "selection")}>
            {t("share.selection")}
          </Button>
          <Button aria-pressed={state.pane === "preview"} onClick={() => setState("pane", "preview")}>
            {t("share.preview")}
          </Button>
        </div>
        <div class="session-share-feedback">
          <Show when={state.loading}>
            <p role="status">{t("share.loading")}</p>
          </Show>
          <Show when={state.error}>
            <p role="alert">{state.error}</p>
            <Show when={!state.messages.length}>
              <Button onClick={load}>{t("share.retry")}</Button>
            </Show>
          </Show>
        </div>
        <div class="session-share-columns">
          <section class="session-share-selection" aria-label={t("share.selection")}>
            <div class="session-share-selection-header">
              <div class="session-share-selection-heading">
                <h3 class="text-14-medium">{t("share.selection")}</h3>
                <span
                  class="text-14-medium text-text-weak"
                  aria-live="polite"
                  aria-label={t("share.count", { selected: state.selected.length, total: state.messages.length })}
                >
                  {state.selected.length}/{state.messages.length}
                </span>
              </div>
              <div class="session-share-selection-tools">
                <Button
                  disabled={!!state.busy}
                  onClick={() =>
                    setState("selected", selectVisibleShareMessages(state.selected, state.messages, state.role))
                  }
                >
                  {t("share.all")}
                </Button>
                <Button disabled={!!state.busy} onClick={() => setState("selected", [])}>
                  {t("share.clear")}
                </Button>
                <select
                  aria-label={t("share.filter")}
                  value={state.role}
                  onChange={(event) => setState("role", event.currentTarget.value)}
                >
                  <option value="all">{t("share.roles")}</option>
                  <option value="user">{t("share.user")}</option>
                  <option value="assistant">{t("share.assistant")}</option>
                </select>
              </div>
            </div>
            <div class="session-share-message-list">
              <For each={visibleShareMessages(state.messages, state.role)}>
                {(item) => (
                  <SessionShareMessage
                    message={item}
                    selected={state.selected.includes(item.id)}
                    disabled={!!state.busy}
                    roleLabel={t(item.role === "user" ? "share.user" : "share.assistant")}
                    expandLabel={t("share.expand")}
                    collapseLabel={t("share.collapse")}
                    onToggle={() =>
                      setState(
                        "selected",
                        toggleShareSelection(state.selected, item.id, !state.selected.includes(item.id)),
                      )
                    }
                  />
                )}
              </For>
            </div>
          </section>
          <section class="session-share-preview" aria-label={t("share.preview")}>
            <div class="session-share-preview-heading">
              <h3 class="text-14-medium">{t("share.preview")}</h3>
              <label class="session-share-theme">
                {t("share.theme")}
                <select
                  aria-label={t("share.theme")}
                  value={state.theme}
                  disabled={!!state.busy}
                  onChange={(event) => setState("theme", event.currentTarget.value as "light" | "dark")}
                >
                  <option value="light">{t("share.light")}</option>
                  <option value="dark">{t("share.dark")}</option>
                </select>
              </label>
            </div>
            <div class="session-share-paper-scroll" data-theme={state.theme} style={paperTheme()}>
              <div ref={preview} class="session-share-paper">
                <Show when={markdown()} keyed>
                  {(text) => <Markdown text={text} eager stage="full" />}
                </Show>
              </div>
            </div>
          </section>
        </div>
        <footer class="session-share-footer">
          <div class="session-share-export-buttons">
            <For each={["png", "markdown", "pdf"] as const}>
              {(format) => (
                <Button
                  disabled={state.loading || !state.selected.length || !!state.busy || !platform.exportSessionDocument}
                  onClick={() => exportDocument(format)}
                >
                  {t(`share.${format}`)}
                </Button>
              )}
            </For>
          </div>
          <p role="status">
            {state.busy ? (state.stage === "preparing" ? t("share.preparing") : t("share.saving")) : state.result}
          </p>
          <Show when={!platform.exportSessionDocument}>
            <p>{t("share.unavailable")}</p>
          </Show>
        </footer>
      </div>
    </Dialog>
  )
}
