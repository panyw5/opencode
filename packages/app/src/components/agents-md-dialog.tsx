import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { MarkdownEditorField } from "@/components/markdown-editor-field"

export function AgentsMdDialog(props: {
  directory: string
  onSaved?: () => void
}): JSX.Element {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const agentsMdPath = () => `${props.directory}/AGENTS.md`

  const [text, setText] = createSignal("")
  const [saved, setSaved] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)

  const dirty = createMemo(() => text() !== saved())

  const load = async () => {
    if (!platform.readLocalFile) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const content = await platform.readLocalFile(agentsMdPath())
      const value = content ?? ""
      setText(value)
      setSaved(value)
    } catch (err) {
      console.error("[agents-md] failed to read", err)
      setText("")
      setSaved("")
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    if (!platform.writeLocalFile) return
    setSaving(true)
    try {
      await platform.writeLocalFile(agentsMdPath(), text())
      setSaved(text())
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("common.save"),
        description: "AGENTS.md",
      })
      props.onSaved?.()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSaving(false)
    }
  }

  const refresh = async () => {
    if (refreshing()) return
    setRefreshing(true)
    try {
      await load()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("common.refresh"),
        description: "AGENTS.md",
      })
    } finally {
      setRefreshing(false)
    }
  }

  void load()

  return (
    <Dialog
      title={
        <div class="flex min-w-0 flex-col pl-1">
          <span>AGENTS.md</span>
          <span class="mt-0.5 truncate text-12-regular text-text-weak">{agentsMdPath()}</span>
        </div>
      }
      size="x-large"
      transition
      containerStyle={{
        width: "min(calc(100vw - 32px), 1120px)",
        height: "min(calc(100vh - 32px), 860px)",
      }}
    >
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <Show
          when={!loading()}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          }
        >
          <div class="grid min-h-0 flex-1 gap-4 overflow-hidden">
            <MarkdownEditorField
              text={text()}
              preview
              defaultMode="preview"
              busy={refreshing()}
              placeholder={language.t("agentsMd.dialog.placeholder")}
              onInput={(value) => setText(value)}
              class="h-full min-h-[640px] min-w-0 bg-background-base"
            />
          </div>

          <div class="mt-4 flex shrink-0 items-center gap-2 border-t border-border-weak-base pt-4">
            <Show when={dirty()}>
              <span class="text-12-regular text-text-weak">
                {language.t("common.unsavedChanges")}
              </span>
            </Show>
            <div class="ml-auto flex items-center gap-2">
              <Tooltip placement="top" value={language.t("common.refresh")}>
                <IconButton
                  icon="refresh"
                  variant="ghost"
                  disabled={refreshing() || loading()}
                  onClick={() => void refresh()}
                  aria-label={language.t("common.refresh")}
                />
              </Tooltip>
              <Button
                type="button"
                variant="ghost"
                onClick={() => dialog.close()}
              >
                {language.t("common.close")}
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!dirty() || saving()}
                onClick={() => void save()}
              >
                {saving() ? language.t("common.saving") : language.t("common.save")}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}


