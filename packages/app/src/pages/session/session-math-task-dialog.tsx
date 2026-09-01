import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { SessionMathWorkerEntry } from "@/pages/session/session-math-float"

export function SessionMathTaskDialog(props: {
  worker: SessionMathWorkerEntry
  task: string
  onSave: (task: string) => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [store, setStore] = createStore({ task: props.task, saving: false, error: "" })

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
    <Dialog title={language.t("session.mathTask.title")} class="mx-auto w-full max-w-[680px]">
      <form class="flex flex-col gap-4 p-6 pt-0" onSubmit={save}>
        <div>
          <div class="text-13-medium text-text-strong">{props.worker.title}</div>
          <div class="mt-1 font-mono text-11-regular text-text-weak">
            {props.worker.sessionID} · {props.worker.project}
          </div>
        </div>
        <p class="text-12-regular leading-5 text-text-weak">{language.t("session.mathTask.description")}</p>
        <TextField
          autofocus
          multiline
          label={language.t("session.mathTask.body")}
          value={store.task}
          onChange={(value) => setStore("task", value)}
          class="min-h-64 max-h-[50dvh] overflow-y-auto font-mono text-12-regular"
        />
        {store.error ? <p class="text-12-regular text-text-danger">{store.error}</p> : null}
        <div class="flex justify-end gap-2">
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
