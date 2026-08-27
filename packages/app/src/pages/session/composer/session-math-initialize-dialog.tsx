import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopover, useBoundModelState } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import {
  type MathInitializationConfig,
  defaultMathProjectName,
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
  const workerModel = useBoundModelState({
    value: () => store.workerModel,
    onChange: (value) => setStore("workerModel", value),
  })
  const selectedModel = createMemo(() => workerModel.current())
  const valid = createMemo(
    () =>
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
      size="large"
      class="mx-auto h-full"
      containerStyle={{ height: "min(calc(100vh - 32px), 720px)" }}
    >
      <form
        class="h-full min-h-0 overflow-y-auto flex flex-col gap-6 p-7 pt-1"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div class="grid gap-4 md:grid-cols-2">
          <div class="md:col-span-2 flex flex-col gap-2">
            <label class="text-12-medium text-text-weak">{language.t("session.mathInitialize.model")}</label>
            <ModelSelectorPopover
              model={workerModel}
              triggerAs={Button}
              triggerProps={{
                type: "button",
                variant: "ghost",
                class:
                  "h-11 w-full justify-between rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong transition-colors hover:border-border-strong hover:bg-surface-base-hover",
              }}
            >
              <div class="flex min-w-0 items-center gap-2">
                <Show when={selectedModel()?.provider.id}>
                  <ProviderIcon id={selectedModel()!.provider.id} class="size-4 shrink-0" />
                </Show>
                <span class="truncate">
                  {selectedModel()
                    ? `${selectedModel()!.provider.name} / ${selectedModel()!.name}`
                    : store.workerModel || language.t("dialog.model.select.title")}
                </span>
              </div>
              <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
            </ModelSelectorPopover>
            <p class="text-11-regular text-text-weak">{language.t("session.mathInitialize.model.description")}</p>
          </div>
          <div class="md:col-span-2">
            <TextField
              autofocus
              multiline
              label={language.t("session.mathInitialize.problem")}
              description={language.t("session.mathInitialize.problem.description")}
              value={store.problem}
              onChange={(value) => setStore("problem", value)}
              class="min-h-44"
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
        <div class="mt-auto flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="large"
            disabled={!valid()}
            class="transition-[transform,box-shadow,filter] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-md hover:brightness-105 active:translate-y-0 active:scale-[0.97] active:shadow-sm motion-reduce:transform-none motion-reduce:transition-none"
          >
            {language.t("session.mathInitialize.prepare")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
