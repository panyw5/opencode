import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { showToast } from "@opencode-ai/ui/toast"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { Part } from "@opencode-ai/sdk/v2/client"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import {
  collectSessionFileChanges,
  collectSessionReportedFileChanges,
  type SessionFileChange,
} from "./session-file-changes"

const historyPageSize = 100

export function SessionStatusFloat(props: {
  sessionID?: string
  skills: string[]
  diffs: SnapshotFileDiff[]
  childSessionIDs: string[]
}) {
  const language = useLanguage()
  const sdk = useSDK()
  const [shown, setShown] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [childDiffs, setChildDiffs] = createSignal<SnapshotFileDiff[]>([])
  const [reportedFileChanges, setReportedFileChanges] = createSignal<SessionFileChange[]>([])
  const fileChanges = createMemo(() =>
    collectSessionFileChanges([...props.diffs, ...childDiffs()], reportedFileChanges(), sdk.directory),
  )
  const hasFileChanges = createMemo(() => Object.values(fileChanges()).some((files) => files.length > 0))
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

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

  createEffect(() => {
    if (!shown()) return
    if (!props.sessionID) return
    const sessionIDs = [...new Set([props.sessionID, ...props.childSessionIDs])]
    let cancelled = false
    setChildDiffs([])
    setReportedFileChanges([])
    console.info("[session-status] loading file change history", { sessionIDs })

    void Promise.all(
      sessionIDs.map(async (sessionID) => {
        const [diff, messages] = await Promise.all([
          sdk.client.session.diff({ sessionID }),
          loadAllMessages(sdk.client, sessionID),
        ])
        const parts = messages
          .filter((message) => message.info.role === "assistant")
          .flatMap((message) => message.parts as Part[])
        console.info("[session-status] loaded file change history", {
          sessionID,
          diffs: diff.data?.length ?? 0,
          messages: messages.length,
          reported: parts.length,
        })
        return { sessionID, diffs: diff.data ?? [], reported: collectSessionReportedFileChanges(parts) }
      }),
    )
      .then((results) => {
        if (cancelled) return
        setChildDiffs(
          results.filter((result) => result.sessionID !== props.sessionID).flatMap((result) => result.diffs),
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
  })

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
                  <FileChangeList title={language.t("session.status.files.added")} files={fileChanges().added} />
                  <FileChangeList title={language.t("session.status.files.modified")} files={fileChanges().modified} />
                  <FileChangeList title={language.t("session.status.files.deleted")} files={fileChanges().deleted} />
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Popover>
    </div>
  )
}

async function loadAllMessages(client: ReturnType<typeof useSDK>["client"], sessionID: string) {
  const result: Array<{ info: { role: string }; parts: unknown[] }> = []
  let before: string | undefined
  do {
    const response = await client.session.messages({ sessionID, limit: historyPageSize, before })
    result.push(...((response.data ?? []) as Array<{ info: { role: string }; parts: unknown[] }>))
    before = response.response.headers.get("x-next-cursor") ?? undefined
  } while (before)
  return result
}

function FileChangeList(props: { title: string; files: string[] }) {
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
          <ul class="mt-1.5 space-y-1">
            <For each={props.files}>
              {(file) => (
                <li class="rounded-lg border border-border-weaker-base bg-surface-base px-2.5 py-1.5 text-12-regular text-text-strong shadow-xs-border-base">
                  <code class="block break-all font-mono">{file}</code>
                </li>
              )}
            </For>
          </ul>
        </Collapsible.Content>
      </Collapsible>
    </Show>
  )
}
