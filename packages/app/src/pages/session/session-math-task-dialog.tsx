import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createStore } from "solid-js/store"
import { MarkdownEditorField } from "@/components/markdown-editor-field"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import type { SessionMathWorkerEntry } from "@/pages/session/session-math-float"

export function SessionMathTaskDialog(props: {
  worker: SessionMathWorkerEntry
  task: string
  onSave: (task: string) => Promise<void>
}) {
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const [store, setStore] = createStore({ task: props.task, saving: false, error: "", maximized: false })

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const task = store.task.trim()
    if (!task || store.saving) return
    setStore({ saving: true, error: "" })
    try {
      await props.onSave(task)
      dialog.close()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    } finally {
      setStore("saving", false)
    }
  }

  return (
    <Dialog
      title={language.t("session.mathTask.title")}
      size={store.maximized ? "x-large" : "large"}
      transition
      class="mx-auto h-full"
      action={
        <div class="flex items-center gap-2">
          <Tooltip
            placement="bottom"
            value={language.t(store.maximized ? "prompt.editor.restore" : "prompt.editor.maximize")}
          >
            <IconButton
              type="button"
              icon={store.maximized ? "collapse" : "expand"}
              variant="ghost"
              size="large"
              aria-label={language.t(store.maximized ? "prompt.editor.restore" : "prompt.editor.maximize")}
              onClick={() => {
                const maximized = !store.maximized
                console.debug(`[math-task] maximize=${String(maximized)} worker=${props.worker.sessionID}`)
                setStore("maximized", maximized)
              }}
            />
          </Tooltip>
          <Tooltip placement="bottom" value={language.t("common.close")}>
            <IconButton
              type="button"
              icon="close"
              variant="ghost"
              size="large"
              aria-label={language.t("common.close")}
              onClick={() => dialog.close()}
            />
          </Tooltip>
        </div>
      }
      containerStyle={{
        width: store.maximized ? "92vw" : "min(calc(100vw - 32px), 960px)",
        height: store.maximized ? "95vh" : "min(calc(100vh - 32px), 760px)",
        "max-height": store.maximized ? "95vh" : undefined,
        transition: "width 180ms cubic-bezier(0.16, 1, 0.3, 1), height 180ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <form class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-7 pt-1" onSubmit={save}>
        <div class="shrink-0">
          <div class="text-13-medium text-text-strong">{props.worker.title}</div>
          <div class="mt-1 font-mono text-11-regular text-text-weak">
            {props.worker.sessionID} · {props.worker.project}
          </div>
        </div>
        <p class="shrink-0 text-12-regular leading-5 text-text-weak">{language.t("session.mathTask.description")}</p>
        <div class="flex min-h-0 flex-1 flex-col gap-2">
          <label class="shrink-0 text-12-medium text-text-weak">{language.t("session.mathTask.body")}</label>
          <div class="min-h-64 flex-1 overflow-hidden">
            <MarkdownEditorField
              text={store.task}
              autofocus
              mentions
              preview
              toolbarAbove
              searchFilesAndDirectories={file.searchFilesAndDirectories}
              onInput={(value) => setStore("task", value)}
            />
          </div>
        </div>
        {store.error ? <p class="shrink-0 text-12-regular text-text-danger">{store.error}</p> : null}
        <div class="flex shrink-0 justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!store.task.trim() || store.saving}>
            {store.saving ? language.t("common.saving") : language.t("session.mathTask.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
