import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Icon } from "@opencode-ai/ui/icon"
import { DateTime } from "luxon"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/core/util/path"

export function DialogFavoriteSessions(props: {
  load: () => Promise<GlobalSession[]>
  onSelect: (session: GlobalSession) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  let pending: Promise<GlobalSession[]> | undefined
  const items = () => (pending ??= props.load())

  const handleSelect = (session: GlobalSession | undefined) => {
    if (!session) return
    dialog.close()
    props.onSelect(session)
  }

  return (
    <Dialog size="large" class="!min-h-[520px] !max-h-[600px]" transition title={language.t("home.favoriteSessions")}>
      <List<GlobalSession>
        search={{ placeholder: language.t("session.favorite.placeholder"), autofocus: true }}
        emptyMessage={language.t("session.favorite.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(item) => item.id}
        filterKeys={["title", "directory"]}
        onSelect={handleSelect}
      >
        {(item) => {
          const favorited = () =>
            DateTime.fromMillis(item.time.favorited ?? item.time.updated ?? item.time.created)
              .setLocale(language.intl())
              .toRelative()
          const workspace = () =>
            item.project?.name || getFilename(item.project?.worktree ?? item.directory) || item.directory
          return (
            <div class="w-full flex items-center justify-between rounded-md pl-1">
              <div class="flex items-center grow min-w-0">
                <div class="size-6 rounded shrink-0 flex items-center justify-center bg-surface-base">
                  <Icon name="star-active" class="text-icon-warning-base size-4" />
                </div>
                <span class="text-14-medium text-text-base truncate grow min-w-0 pl-4">
                  {item.title?.trim() || item.id.slice(0, 8)}
                </span>
                <span class="text-12-regular text-text-weak truncate shrink-0 max-w-[10rem] text-left pl-3">
                  {workspace()}
                </span>
                <span class="text-12-regular text-text-weak shrink-0 whitespace-nowrap pl-2">{favorited()}</span>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
