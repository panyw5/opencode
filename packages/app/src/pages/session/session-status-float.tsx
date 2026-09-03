import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { Part } from "@opencode-ai/sdk/v2/client"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createOpenSessionFileTab } from "./helpers"
import { useSessionLayout } from "./session-layout"
import {
  collectSessionFileChanges,
  collectSessionReportedFileChanges,
  type SessionFileChange,
  type SessionFileChanges,
} from "./session-file-changes"
import { sessionStatusHistoryKey } from "./session-status-history"

const historyPageSize = 100

const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1) || file

export function SessionStatusFloat(props: {
  sessionID?: string
  skills: string[]
  diffs: SnapshotFileDiff[]
  childSessionIDs: string[]
}) {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const sdk = useSDK()
  const file = useFile()
  const { tabs, view } = useSessionLayout()
  const [shown, setShown] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [childDiffs, setChildDiffs] = createSignal<SnapshotFileDiff[]>([])
  const [reportedFileChanges, setReportedFileChanges] = createSignal<SessionFileChange[]>([])
  const historyLoads = new Map<
    string,
    Promise<{ sessionID: string; diffs: SnapshotFileDiff[]; reported: SessionFileChange[] }>
  >()
  // Git projects trust the snapshot diff (authoritative git state) and only
  // fall back to tool-reported changes for snapshot blind spots (e.g. files
  // exceeding the snapshot limit). Non-git projects have no snapshot, so tool
  // metadata (real executed writes) is the only trustworthy source.
  const isGit = createMemo(() => sync.project?.vcs === "git")
  const fileChanges = createMemo(() =>
    collectSessionFileChanges(isGit() ? [...props.diffs, ...childDiffs()] : [], reportedFileChanges(), sdk.directory),
  )
  const hasFileChanges = createMemo(() => Object.values(fileChanges()).some((files) => files.length > 0))
  const openFilePreview = () => {
    if (!view().filePreview.opened()) view().filePreview.open()
  }
  const openFileTab = createOpenSessionFileTab({
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel: openFilePreview,
    setActive: tabs().setActive,
  })
  const openChangedFile = (path: string) => {
    setShown(false)
    openFileTab(file.tab(path))
  }
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  let historyOwnerSessionID: string | undefined

  const loadHistory = (sessionID: string, includeDiff: boolean) => {
    const key = `${sdk.directory}\n${sessionID}\n${String(includeDiff)}`
    const pending = historyLoads.get(key)
    if (pending) return pending
    const promise = Promise.all([
      includeDiff ? globalSync.session.diff.ensure(sdk.directory, sessionID) : Promise.resolve([]),
      loadAllMessageParts(globalSync, sdk.directory, sessionID),
    ])
      .then(([diff, parts]) => {
        console.info("[session-status] loaded file change history", {
          sessionID,
          diffs: diff?.length ?? 0,
          reported: parts.length,
        })
        return { sessionID, diffs: diff ?? [], reported: collectSessionReportedFileChanges(parts) }
      })
      .catch((error) => {
        if (historyLoads.get(key) === promise) historyLoads.delete(key)
        throw error
      })
    historyLoads.set(key, promise)
    return promise
  }

  const copySessionDetails = () => {
    const sessionID = props.sessionID
    const directory = sdk.directory
    if (!sessionID || !directory) return

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    const value = `Session ID: ${sessionID}\nProject path: ${directory}`
    console.debug("[session-status] copying session details", { sessionID, directory })
    if (!clipboard?.writeText) {
      console.debug("[session-status] clipboard unavailable", { sessionID, directory })
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: "Clipboard unavailable" })
      return
    }

    void clipboard.writeText(value).then(
      () => {
        console.debug("[session-status] copied session details", { sessionID, directory })
        setCopied(true)
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => setCopied(false), 1_200)
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.debug("[session-status] copy session details failed", { sessionID, directory, message })
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
      },
    )
  }

  onCleanup(() => {
    if (copiedTimer) clearTimeout(copiedTimer)
  })

  createEffect(
    on(
      () => [shown(), sdk.directory, sessionStatusHistoryKey(props.sessionID, props.childSessionIDs)] as const,
      ([open]) => {
        if (!open) {
          historyLoads.clear()
          historyOwnerSessionID = undefined
          return
        }
        const currentSessionID = props.sessionID
        if (!currentSessionID) return
        if (historyOwnerSessionID !== currentSessionID) {
          historyLoads.clear()
          historyOwnerSessionID = currentSessionID
        }
        const sessionIDs = [...new Set([currentSessionID, ...props.childSessionIDs])]
        let cancelled = false
        setChildDiffs([])
        setReportedFileChanges([])
        console.info("[session-status] loading file change history", { sessionIDs })

        void Promise.all(sessionIDs.map((sessionID) => loadHistory(sessionID, sessionID !== currentSessionID)))
          .then((results) => {
            if (cancelled) return
            setChildDiffs(
              results.filter((result) => result.sessionID !== currentSessionID).flatMap((result) => result.diffs),
            )
            setReportedFileChanges(results.flatMap((result) => result.reported))
            console.info("[session-status] merged file change history", {
              sessionIDs,
              diffs: results.reduce((count, result) => count + result.diffs.length, 0),
              reported: results.reduce((count, result) => count + result.reported.length, 0),
            })
          })
          .catch((error) => {
            if (cancelled) return
            console.warn("[session-status] failed to load file change history", { sessionIDs, error })
          })

        onCleanup(() => {
          cancelled = true
        })
      },
    ),
  )

  return (
    <div
      data-component="session-status-float"
      data-action="session-status-toggle-button"
      data-expanded={shown() ? "true" : "false"}
      class="absolute top-3 right-3 z-20 pointer-events-auto"
    >
      <Popover
        open={shown()}
        onOpenChange={setShown}
        triggerAs="button"
        triggerProps={{
          type: "button",
          "aria-label": shown() ? language.t("session.status.collapse") : language.t("session.status.expand"),
          class:
            "inline-flex items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-2 shadow-sm text-13-medium text-text-strong hover:bg-surface-raised-base-hover transition-colors",
        }}
        trigger={
          <>
            <Icon name="status" size="small" class="text-icon-weak" />
            <span>{language.t("session.status.button")}</span>
            <span class="mx-0.5 inline-block size-0.5 rounded-full bg-border-weak-base" />
            <SessionContextUsage variant="capsule" />
          </>
        }
        class="w-[500px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border-base bg-surface-raised-stronger p-0 shadow-xl"
        style={{
          "max-height": "min(960px, calc(100dvh - 24px))",
        }}
        gutter={8}
        placement="bottom-end"
      >
        <div data-slot="session-status-float-panel" class="flex max-h-[min(960px,calc(100dvh-24px))] flex-col">
          <div class="flex items-center justify-between px-3 py-2 border-b border-border-weaker-base">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="shrink-0 text-13-medium text-text-strong">{language.t("session.status.title")}</span>
              <Show when={props.sessionID}>
                {(sessionID) => (
                  <>
                    <span class="min-w-0 truncate font-mono text-12-regular text-text-weak" title={sessionID()}>
                      {sessionID()}
                    </span>
                    <IconButton
                      data-action="session-status-copy-details"
                      icon={copied() ? "check" : "copy"}
                      size="normal"
                      variant="ghost"
                      aria-label={language.t("session.status.copyDetails")}
                      onClick={copySessionDetails}
                    />
                  </>
                )}
              </Show>
            </div>
            <IconButton
              data-action="session-status-float-close"
              icon="close"
              size="normal"
              variant="ghost"
              aria-label={language.t("session.status.collapse")}
              onClick={() => setShown(false)}
            />
          </div>
          <div class="min-h-0 overflow-y-auto no-scrollbar">
            <div class="border-b border-border-weaker-base py-2">
              <h3 class="px-3 py-1 text-13-medium text-text-strong">{language.t("session.status.skills")}</h3>
              <Show
                when={props.skills.length > 0}
                fallback={<p class="px-3 py-4 text-13-regular text-text-weak">{language.t("session.status.empty")}</p>}
              >
                <ul class="flex flex-wrap gap-2 px-3 py-2">
                  <For each={props.skills}>
                    {(skill) => (
                      <li class="inline-flex rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong shadow-xs-border-base">
                        <code class="font-mono">{skill}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
            <SessionContextUsage variant="panel" />
            <Show when={hasFileChanges()}>
              <div data-slot="session-status-file-changes" class="border-b border-border-weaker-base px-3 py-3">
                <div class="flex flex-col gap-3">
                  <FileChangeList
                    title={language.t("session.status.files.added")}
                    files={fileChanges().added}
                    status="added"
                    onOpen={openChangedFile}
                  />
                  <FileChangeList
                    title={language.t("session.status.files.modified")}
                    files={fileChanges().modified}
                    status="modified"
                    onOpen={openChangedFile}
                  />
                  <FileChangeList
                    title={language.t("session.status.files.deleted")}
                    files={fileChanges().deleted}
                    status="deleted"
                    onOpen={openChangedFile}
                  />
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Popover>
    </div>
  )
}

async function loadAllMessageParts(
  globalSync: ReturnType<typeof useGlobalSync>,
  directory: string,
  sessionID: string,
) {
  // Pages are fetched newest-first; keep each page's internal order but reverse
  // the page order so the result is chronological across the whole session.
  const pages: Part[][] = []
  let before: string | undefined
  do {
    const page = await globalSync.session.messages.page({ directory, sessionID, limit: historyPageSize, before })
    const assistant = new Set(page.session.filter((message) => message.role === "assistant").map((message) => message.id))
    pages.push(page.part.filter((item) => assistant.has(item.id)).flatMap((item) => item.part))
    before = page.cursor
  } while (before)
  return pages.reverse().flat()
}

function FileChangeList(props: {
  title: string
  files: string[]
  status: keyof SessionFileChanges
  onOpen: (file: string) => void
}) {
  const [open, setOpen] = createSignal(false)

  return (
    <Show when={props.files.length > 0}>
      <Collapsible
        data-slot="session-status-file-change-list"
        variant="ghost"
        open={open()}
        onOpenChange={setOpen}
      >
        <Collapsible.Trigger>
          <div class="flex w-full items-center justify-between gap-2">
            <span class="text-13-medium text-text-strong">
              {props.title}
              <span class="ml-1.5 text-12-regular text-text-weak">({props.files.length})</span>
            </span>
            <Collapsible.Arrow style={{ opacity: 1 }} />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <ul class="mt-1.5 space-y-0.5">
            <For each={props.files}>
              {(file) => (
                <li>
                  <Tooltip
                    value={<span class="block max-w-full truncate font-mono text-12-regular">{file}</span>}
                    contentStyle={{ "max-width": "none", "white-space": "nowrap" }}
                    placement="left"
                  >
                    <Show
                      when={props.status !== "deleted"}
                      fallback={
                        // Deleted files no longer exist, so there is nothing to preview.
                        <div
                          data-action="session-status-file-deleted"
                          data-file={file}
                          class="block w-full px-2.5 py-1.5 text-left text-12-regular text-text-weak"
                        >
                          <code class="block truncate font-mono">{baseName(file)}</code>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        data-action="session-status-open-file"
                        data-file={file}
                        class="block w-full rounded-md px-2.5 py-1.5 text-left text-12-regular text-text-strong transition-colors hover:bg-surface-raised-base-hover"
                        onClick={() => props.onOpen(file)}
                      >
                        <code class="block truncate font-mono">{baseName(file)}</code>
                      </button>
                    </Show>
                  </Tooltip>
                </li>
              )}
            </For>
          </ul>
        </Collapsible.Content>
      </Collapsible>
    </Show>
  )
}
