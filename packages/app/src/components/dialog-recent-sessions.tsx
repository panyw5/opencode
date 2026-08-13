import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Icon } from "@opencode-ai/ui/icon"
import { DateTime } from "luxon"
import { createMemo, Show, type Accessor } from "solid-js"
import type { GlobalSession, Session } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/core/util/path"

export function DialogRecentSessions(props: {
  load: () => Promise<GlobalSession[]>
  currentSessionID?: Accessor<string | undefined>
  onSelect: (session: Session) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  let pending: Promise<GlobalSession[]> | undefined
  const items = () => (pending ??= props.load())

  const current = createMemo(() => props.currentSessionID?.())

  const handleSelect = (session: GlobalSession | undefined) => {
    if (!session) return
    dialog.close()
    props.onSelect(session)
  }

  return (
    <Dialog title={language.t("command.session.recent")}>
      <List<GlobalSession>
        search={{ placeholder: language.t("session.recent.placeholder"), autofocus: true }}
        emptyMessage={language.t("session.recent.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(item) => item.id}
        filterKeys={["title", "directory"]}
        onSelect={handleSelect}
      >
        {(item) => {
          const isCurrent = () => current() === item.id
          const updated = () =>
            DateTime.fromMillis(item.time.updated ?? item.time.created)
              .setLocale(language.intl())
              .toRelative()
          const workspace = () => item.project?.name || getFilename(item.project?.worktree ?? item.directory) || item.directory
          return (
            <div class="w-full flex items-center justify-between rounded-md pl-1">
              <div class="flex items-center grow min-w-0">
                <div class="size-6 rounded shrink-0 flex items-center justify-center bg-surface-base">
                  <Icon name="speech-bubble" class="text-icon-base size-4" />
                </div>
                <span class="text-14-medium text-text-base truncate w-[220px] shrink-0 pl-4">
                  {item.title?.trim() || item.id.slice(0, 8)}
                </span>
                <span class="text-12-regular text-text-weak truncate grow min-w-0 text-left pl-3">
                  {workspace()} · {updated()}
                </span>
                <Show when={isCurrent()}>
                  <span class="text-12-regular text-text-weak shrink-0 ml-2">
                    {language.t("project.switch.current")}
                  </span>
                </Show>
              </div>
              <Show when={isCurrent()}>
                <Icon name="check" size="small" class="text-icon-success-base shrink-0 ml-2" />
              </Show>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
