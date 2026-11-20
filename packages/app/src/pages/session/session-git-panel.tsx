import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createEffect, createResource, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform, type GitPanelStatus } from "@/context/platform"

type Change = GitPanelStatus["files"][number]

function pathParts(path: string) {
  const slash = path.lastIndexOf("/")
  return { name: path.slice(slash + 1), parent: path.slice(0, slash) }
}

export function SessionGitPanel(props: { directory: string; close: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  const t = language.t
  const [form, setForm] = createStore({
    message: "",
    overrides: {} as Record<string, boolean>,
    trackedOpen: true,
    untrackedOpen: true,
    busy: false,
    notice: undefined as { text: string; error?: string } | undefined,
  })
  const [status, { refetch }] = createResource(async () => {
    try {
      return { data: (await platform.gitStatus?.(props.directory)) ?? null }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  const repo = () => status()?.data
  const selected = (file: Change) =>
    form.overrides[`/${file.path}`] ?? !file.untracked
  const files = () => repo()?.files ?? []
  const selectedFiles = () => files().filter(selected)
  const available = () => !form.busy && !status.loading && !!repo()?.branch
  const canCommit = () => available() && !!form.message.trim() && selectedFiles().length > 0
  const canPush = () => available() && !!repo()?.upstream
  const refresh = () => {
    if (!status.loading && !form.busy) void refetch()
  }

  const run = async (mode: "commit" | "commitPush" | "push") => {
    if ((mode !== "push" && !canCommit()) || (mode !== "commit" && !canPush())) return
    const current = repo()
    if (!current?.branch || !platform.gitCommit || !platform.gitPush) return
    const branch = current.branch
    const upstream = current.upstream
    const message = form.message.trim()
    const paths = selectedFiles().map((entry) => entry.path)
    let committed = false
    setForm({ busy: true, notice: undefined })
    try {
      if (mode !== "push") {
        await platform.gitCommit(props.directory, { paths, message, branch })
        committed = true
        setForm("message", "")
        setForm("overrides", reconcile({}))
      }
      if (mode !== "commit" && upstream) await platform.gitPush(props.directory, { branch, upstream })
      setForm("notice", {
        text: mode === "commit" ? t("session.git.committed") : t("session.git.pushed", { upstream: upstream ?? "" }),
      })
    } catch (err) {
      setForm("notice", {
        text: committed
          ? t("session.git.pushAfterCommitError")
          : t(mode === "push" ? "session.git.pushError" : "session.git.commitError"),
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      await refetch()
      setForm("busy", false)
    }
  }

  const group = (untracked: boolean) => {
    const entries = () => files().filter((entry) => entry.untracked === untracked)
    const count = () => entries().filter(selected).length
    const open = () => (untracked ? form.untrackedOpen : form.trackedOpen)
    const name = () => t(untracked ? "session.git.untracked" : "session.git.tracked")
    return (
      <Show when={entries().length > 0}>
        <section class="mb-2" aria-label={name()}>
          <div class="flex h-8 items-center gap-2 px-2 text-12-medium text-text-weak">
            <button
              type="button"
              class="grid size-5 shrink-0 place-items-center rounded hover:bg-surface-raised-base-hover focus-visible:outline"
              aria-expanded={open()}
              aria-label={name()}
              onClick={() => setForm(untracked ? "untrackedOpen" : "trackedOpen", !open())}
            >
              <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
            </button>
            <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                class="size-3.5 shrink-0 cursor-pointer accent-[var(--button-primary-base)]"
                checked={count() === entries().length}
                ref={(input) => createEffect(() => (input.indeterminate = count() > 0 && count() < entries().length))}
                disabled={form.busy}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setForm("overrides", (previous) => ({
                    ...previous,
                    ...Object.fromEntries(entries().map((entry) => [`/${entry.path}`, checked])),
                  }))
                }}
              />
              <span>{name()}</span>
            </label>
            <span class="pr-1 tabular-nums">{entries().length}</span>
          </div>
          <Show when={open()}>
            <For each={entries()}>
              {(entry) => {
                const path = pathParts(entry.path)
                return (
                  <label
                    class="mx-1 flex min-h-7 cursor-pointer items-center gap-2 rounded-md py-0.5 pl-9 pr-3 text-12-regular hover:bg-[color-mix(in_srgb,var(--text-strong)_9%,transparent)] focus-within:bg-[color-mix(in_srgb,var(--text-strong)_9%,transparent)]"
                    title={entry.path}
                  >
                    <input
                      type="checkbox"
                      class="size-3.5 shrink-0 cursor-pointer accent-[var(--button-primary-base)]"
                      aria-label={entry.path}
                      checked={selected(entry)}
                      disabled={form.busy}
                      onChange={(event) => setForm("overrides", `/${entry.path}`, event.currentTarget.checked)}
                    />
                    <FileIcon node={{ path: entry.path, type: "file" }} class="size-4 shrink-0" />
                    <span class="min-w-0 truncate text-text-strong">{path.name}</span>
                    <span class="min-w-0 flex-1 truncate text-text-weak">{path.parent}</span>
                    <span
                      class="shrink-0 font-mono"
                      classList={{ "text-text-success-base": entry.untracked, "text-text-info-base": !entry.untracked }}
                      title={entry.status}
                    >
                      {entry.untracked ? "U" : entry.status.trim()}
                    </span>
                  </label>
                )
              }}
            </For>
          </Show>
        </section>
      </Show>
    )
  }

  return (
    <div data-component="session-git-panel" class="flex size-full min-h-0 min-w-0 flex-col bg-background-base">
      <div class="shrink-0 border-b border-border-weaker-base px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="grid size-7 shrink-0 place-items-center rounded-md bg-surface-raised-base text-icon-strong">
            <Icon name="branch" size="small" />
          </span>
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-14-medium text-text-strong" title={repo()?.root ?? props.directory}>
              {(repo()?.root ?? props.directory).split(/[/\\]/).filter(Boolean).at(-1) ?? t("session.git.title")}
            </span>
            <span class="text-11-regular text-text-weak">{t("session.git.title")}</span>
          </div>
          <IconButton icon="refresh" variant="ghost" aria-label={t("session.git.refresh")} disabled={status.loading || form.busy} onClick={refresh} />
          <IconButton icon="close" variant="ghost" aria-label={t("session.panel.collapse")} onClick={props.close} />
        </div>
        <Show when={repo()}>
          {(data) => (
            <div class="mt-2 flex min-w-0 items-center gap-2 text-12-regular">
              <Icon name="branch" size="small" class="shrink-0 text-icon-weak" />
              <span class="min-w-0 truncate text-text-strong" title={data().branch ?? undefined}>
                {data().branch ?? t("session.git.detached")}
              </span>
              <span class="min-w-0 flex-1 truncate text-right text-text-weak" title={data().upstream ?? undefined}>
                {data().upstream ?? t("session.git.noUpstream")}
              </span>
              <Show when={data().upstream}>
                <span class="shrink-0 tabular-nums text-text-weak">↓{data().behind} ↑{data().ahead}</span>
                <Button size="small" variant="ghost" disabled={!canPush()} onClick={() => void run("push")}>
                  <Icon name="arrow-up" size="small" />{t("session.git.push")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto py-1">
        <Show when={status.loading && !status()}>
          <div class="grid p-6 place-items-center"><Spinner /></div>
        </Show>
        <Show when={status()?.error}>
          {(error) => <p role="alert" class="m-3 break-words text-12-regular text-text-weak">{t("session.git.statusError")}: {error()}</p>}
        </Show>
        <Show when={status()?.data === null}>
          <p class="m-3 text-12-regular text-text-weak">{t("session.git.noRepository")}</p>
        </Show>
        <Show when={repo() && !files().length}>
          <p class="m-3 text-12-regular text-text-weak">{t("session.git.clean")}</p>
        </Show>
        {group(false)}
        {group(true)}
      </div>

      <Show when={repo()}>
        <footer class="shrink-0 border-t border-border-weaker-base p-3">
          <Show when={form.notice}>
            {(notice) => (
              <div role={notice().error ? "alert" : "status"} class="mb-2 max-h-24 overflow-auto break-words text-12-regular text-text-weak">
                <span class="text-text-strong">{notice().text}</span>
                <Show when={notice().error}>{(error) => <div class="mt-1 whitespace-pre-wrap">{error()}</div>}</Show>
              </div>
            )}
          </Show>
          <form
            class="rounded-lg border border-border-base bg-surface-panel p-2 focus-within:border-border-strong-base"
            onSubmit={(event) => { event.preventDefault(); void run("commit") }}
          >
            <textarea
              aria-label={t("session.git.message")}
              placeholder={t("session.git.message")}
              class="block h-20 w-full resize-y bg-transparent p-1 text-13-regular text-text-strong outline-none placeholder:text-text-weak"
              value={form.message}
              disabled={form.busy || !repo()?.branch}
              onInput={(event) => setForm("message", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return
                event.preventDefault()
                event.stopPropagation()
                void run("commit")
              }}
            />
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" disabled={!canCommit()}>
                {t("session.git.commit", { count: selectedFiles().length })}
              </Button>
              <Button type="button" variant="secondary" disabled={!canCommit() || !canPush()} onClick={() => void run("commitPush")}>
                {t("session.git.commitPush")}
              </Button>
              <Show when={form.busy}><Spinner /></Show>
            </div>
          </form>
          <Show when={repo()?.lastCommit}>
            {(message) => (
              <div class="mt-2 flex min-w-0 items-center gap-2 text-12-regular text-text-weak" title={message()}>
                <Icon name="branch" size="small" class="shrink-0" />
                <span class="shrink-0">{t("session.git.lastCommit")}</span>
                <span class="min-w-0 truncate text-text-strong">{message()}</span>
              </div>
            )}
          </Show>
        </footer>
      </Show>
    </div>
  )
}
