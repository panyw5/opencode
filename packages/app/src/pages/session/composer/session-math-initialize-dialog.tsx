import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import {
  type MathInitializationConfig,
  defaultMathProjectName,
  validMathProjectName,
} from "@/pages/session/math-initialize"

export function SessionMathInitializeDialog(props: {
  directory: string
  defaultModel: string
  onConfirm: (config: MathInitializationConfig) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [store, setStore] = createStore({
    project: defaultMathProjectName(props.directory),
    problem: "",
    workerModel: props.defaultModel,
    highWorkers: "1",
    xhighWorkers: "1",
    controlBeat: false,
  })
  const valid = createMemo(
    () =>
      validMathProjectName(store.project) &&
      store.problem.trim().length > 0 &&
      store.workerModel.trim().includes("/") &&
      Number(store.highWorkers) + Number(store.xhighWorkers) > 0,
  )

  const submit = () => {
    if (!valid()) return
    props.onConfirm(
      {
        project: store.project.trim(),
        problem: store.problem.trim(),
        workerModel: store.workerModel.trim(),
        highWorkers: Number(store.highWorkers),
        xhighWorkers: Number(store.xhighWorkers),
        controlBeat: store.controlBeat,
      },
    )
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("session.mathInitialize.title")}
      class="mx-auto w-full max-w-[640px] !max-h-[calc(100dvh-64px)]"
    >
      <form
        class="min-h-0 overflow-y-auto flex flex-col gap-5 p-6 pt-0"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <p class="text-12-regular leading-5 text-text-weak">{language.t("session.mathInitialize.description")}</p>
        <div class="grid gap-4 md:grid-cols-2">
          <div>
            <TextField
              autofocus
              label={language.t("session.mathInitialize.project")}
              description={language.t("session.mathInitialize.project.description")}
              value={store.project}
              onChange={(value) => setStore("project", value)}
              spellcheck={false}
            />
            <Show when={store.project.trim() && !validMathProjectName(store.project)}>
              <p class="mt-1 text-11-regular text-text-danger">{language.t("session.mathInitialize.project.error")}</p>
            </Show>
          </div>
          <TextField
            label={language.t("session.mathInitialize.model")}
            description={language.t("session.mathInitialize.model.description")}
            value={store.workerModel}
            onChange={(value) => setStore("workerModel", value)}
            placeholder="provider/model"
            spellcheck={false}
          />
          <div class="md:col-span-2">
            <TextField
              multiline
              label={language.t("session.mathInitialize.problem")}
              description={language.t("session.mathInitialize.problem.description")}
              value={store.problem}
              onChange={(value) => setStore("problem", value)}
              class="min-h-32"
            />
          </div>
          <TextField
            type="number"
            min="0"
            max="16"
            label={language.t("session.mathInitialize.highWorkers")}
            value={store.highWorkers}
            onChange={(value) => setStore("highWorkers", value)}
          />
          <TextField
            type="number"
            min="0"
            max="16"
            label={language.t("session.mathInitialize.xhighWorkers")}
            value={store.xhighWorkers}
            onChange={(value) => setStore("xhighWorkers", value)}
          />
        </div>
        <div class="border-y border-border-weak-base py-4">
          <Checkbox
            checked={store.controlBeat}
            onChange={(value) => setStore("controlBeat", value)}
            description={language.t("session.mathInitialize.controlBeat.description")}
          >
            {language.t("session.mathInitialize.controlBeat")}
          </Checkbox>
        </div>
        <div class="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!valid()}>
            {language.t("session.mathInitialize.prepare")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
