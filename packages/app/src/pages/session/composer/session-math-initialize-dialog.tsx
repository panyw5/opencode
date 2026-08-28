import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopover, useBoundModelState } from "@/components/dialog-select-model"
import { MarkdownEditorField } from "@/components/markdown-editor-field"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import {
  type MathInitializationConfig,
  createMathProblemID,
} from "@/pages/session/math-initialize"

export function SessionMathInitializeDialog(props: {
  defaultModel: string
  defaultVerifierModel?: string
  onConfirm: (config: MathInitializationConfig) => void
}) {
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const [store, setStore] = createStore({
    problem: "",
    workerModel: props.defaultModel,
    verifierModel: props.defaultVerifierModel ?? props.defaultModel,
    highWorkers: "1",
    xhighWorkers: "1",
    controlBeat: false,
    maximized: false,
  })
  const workerModel = useBoundModelState({
    value: () => store.workerModel,
    onChange: (value) => setStore("workerModel", value),
  })
  const selectedModel = createMemo(() => workerModel.current())
  const verifierModel = useBoundModelState({
    value: () => store.verifierModel,
    onChange: (value) => setStore("verifierModel", value),
  })
  const selectedVerifierModel = createMemo(() => verifierModel.current())
  const workerCount = (value: string | number) => Math.max(0, Math.min(16, Math.floor(Number(value) || 0)))
  const changeWorkerCount = (key: "highWorkers" | "xhighWorkers", delta: number) => {
    setStore(key, String(workerCount(workerCount(store[key]) + delta)))
  }
  const valid = createMemo(
    () =>
      store.problem.trim().length > 0 &&
      store.workerModel.trim().includes("/") &&
      store.verifierModel.trim().includes("/") &&
      Number(store.highWorkers) + Number(store.xhighWorkers) > 0,
  )

  const submit = () => {
    if (!valid()) return
    const problem = store.problem.trim()
    props.onConfirm(
      {
        project: createMathProblemID(problem),
        problem,
        workerModel: store.workerModel.trim(),
        verifierModel: store.verifierModel.trim(),
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
              onClick={() => setStore("maximized", (value) => !value)}
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
        width: store.maximized ? "90vw" : undefined,
        height: store.maximized ? "95vh" : "min(calc(100vh - 32px), 720px)",
        "max-height": store.maximized ? "95vh" : undefined,
        transition: "width 180ms cubic-bezier(0.16, 1, 0.3, 1), height 180ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <form
        class="h-full min-h-0 overflow-y-auto flex flex-col gap-4 p-7 pt-1"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div class="grid gap-4 md:grid-cols-2">
          <div class="flex min-w-0 flex-col gap-2">
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
          <div class="flex min-w-0 flex-col gap-2">
            <label class="text-12-medium text-text-weak">{language.t("session.mathInitialize.verifierModel")}</label>
            <ModelSelectorPopover
              model={verifierModel}
              triggerAs={Button}
              triggerProps={{
                type: "button",
                variant: "ghost",
                class:
                  "h-11 w-full justify-between rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong transition-colors hover:border-border-strong hover:bg-surface-base-hover",
              }}
            >
              <div class="flex min-w-0 items-center gap-2">
                <Show when={selectedVerifierModel()?.provider.id}>
                  <ProviderIcon id={selectedVerifierModel()!.provider.id} class="size-4 shrink-0" />
                </Show>
                <span class="truncate">
                  {selectedVerifierModel()
                    ? `${selectedVerifierModel()!.provider.name} / ${selectedVerifierModel()!.name}`
                    : store.verifierModel || language.t("dialog.model.select.title")}
                </span>
              </div>
              <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
            </ModelSelectorPopover>
            <p class="text-11-regular text-text-weak">
              {language.t("session.mathInitialize.verifierModel.description")}
            </p>
          </div>
          <div class="md:col-span-2">
            <div class="flex flex-col gap-2">
              <label class="relative z-10 w-fit translate-y-8 text-12-medium text-text-weak">
                {language.t("session.mathInitialize.problem")}
              </label>
              <div class={store.maximized ? "h-[min(50vh,560px)]" : "h-56"}>
                <MarkdownEditorField
                  text={store.problem}
                  autofocus
                  mentions
                  preview
                  toolbarAbove
                  searchFilesAndDirectories={file.searchFilesAndDirectories}
                  placeholder={language.t("session.mathInitialize.problem.description")}
                  onInput={(value) => setStore("problem", value)}
                />
              </div>
              <p class="text-11-regular text-text-weak">{language.t("session.mathInitialize.problem.description")}</p>
            </div>
          </div>
          <div class="md:col-span-2 flex flex-wrap items-start gap-x-6 gap-y-3">
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak" for="math-high-workers">
                {language.t("session.mathInitialize.highWorkers")}
              </label>
              <div class="flex items-center gap-2">
                <IconButton
                  type="button"
                  icon="minus"
                  size="large"
                  class="!size-10"
                  aria-label={`${language.t("session.mathInitialize.workers.decrease")} ${language.t("session.mathInitialize.highWorkers")}`}
                  disabled={workerCount(store.highWorkers) === 0}
                  onClick={() => changeWorkerCount("highWorkers", -1)}
                />
                <div class="w-14">
                  <TextField
                    id="math-high-workers"
                    type="number"
                    min="0"
                    max="16"
                    value={store.highWorkers}
                    aria-label={language.t("session.mathInitialize.highWorkers")}
                    class="!h-10 !px-1 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    onChange={(value) => setStore("highWorkers", value)}
                    onFocusOut={() => setStore("highWorkers", String(workerCount(store.highWorkers)))}
                  />
                </div>
                <IconButton
                  type="button"
                  icon="plus"
                  size="large"
                  class="!size-10"
                  aria-label={`${language.t("session.mathInitialize.workers.increase")} ${language.t("session.mathInitialize.highWorkers")}`}
                  disabled={workerCount(store.highWorkers) === 16}
                  onClick={() => changeWorkerCount("highWorkers", 1)}
                />
              </div>
            </div>
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak" for="math-xhigh-workers">
                {language.t("session.mathInitialize.xhighWorkers")}
              </label>
              <div class="flex items-center gap-2">
                <IconButton
                  type="button"
                  icon="minus"
                  size="large"
                  class="!size-10"
                  aria-label={`${language.t("session.mathInitialize.workers.decrease")} ${language.t("session.mathInitialize.xhighWorkers")}`}
                  disabled={workerCount(store.xhighWorkers) === 0}
                  onClick={() => changeWorkerCount("xhighWorkers", -1)}
                />
                <div class="w-14">
                  <TextField
                    id="math-xhigh-workers"
                    type="number"
                    min="0"
                    max="16"
                    value={store.xhighWorkers}
                    aria-label={language.t("session.mathInitialize.xhighWorkers")}
                    class="!h-10 !px-1 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    onChange={(value) => setStore("xhighWorkers", value)}
                    onFocusOut={() => setStore("xhighWorkers", String(workerCount(store.xhighWorkers)))}
                  />
                </div>
                <IconButton
                  type="button"
                  icon="plus"
                  size="large"
                  class="!size-10"
                  aria-label={`${language.t("session.mathInitialize.workers.increase")} ${language.t("session.mathInitialize.xhighWorkers")}`}
                  disabled={workerCount(store.xhighWorkers) === 16}
                  onClick={() => changeWorkerCount("xhighWorkers", 1)}
                />
              </div>
            </div>
            <div class="min-w-64 flex-1 self-end pb-0.5 md:ml-2">
              <Checkbox
                checked={store.controlBeat}
                onChange={(value) => setStore("controlBeat", value)}
                description={language.t("session.mathInitialize.controlBeat.description")}
              >
                {language.t("session.mathInitialize.controlBeat")}
              </Checkbox>
            </div>
          </div>
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
