import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import type { MathWorkerStatus } from "@/pages/session/math-worker-api"

export type SessionMathWorkerEntry = MathWorkerStatus & { title: string }

export function SessionMathFloat(props: {
  available: boolean
  workers: SessionMathWorkerEntry[]
  busy: string[]
  onInitialize: () => void
  onOpen: (entry: SessionMathWorkerEntry) => void
  onEnsure: (entry: SessionMathWorkerEntry) => void
  onReEnable: (entry: SessionMathWorkerEntry) => void
  onStop: (entry: SessionMathWorkerEntry) => void
  onTask: (entry: SessionMathWorkerEntry) => void
}) {
  const language = useLanguage()
  const [shown, setShown] = createSignal(false)
  const running = createMemo(() => props.workers.filter((worker) => worker.alive && worker.state === "running").length)
  const busy = (entry: SessionMathWorkerEntry) => props.busy.includes(entry.sessionID)
  const projectSummary = createMemo(() => props.workers[0])
  const elapsed = (entry: SessionMathWorkerEntry) => {
    if (!entry.startedAt) return undefined
    const end = entry.alive ? Date.now() : (entry.lastHeartbeatAt ?? entry.transcriptUpdatedAt ?? entry.startedAt)
    const minutes = Math.max(0, Math.floor((end - entry.startedAt) / 60_000))
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }
  const compact = (value?: number) => {
    if (value === undefined) return undefined
    return new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }).format(value)
  }
  const stateClass = (entry: SessionMathWorkerEntry) => {
    if (entry.alive && entry.state === "running") return "text-icon-success-base"
    if (entry.state === "stopping") return "text-icon-warning-base"
    return "text-icon-critical-base"
  }
  const stateLabel = (entry: SessionMathWorkerEntry) => {
    if (entry.state === "running") return language.t("session.mathSwarm.state.running")
    if (entry.state === "stopping") return language.t("session.mathSwarm.state.stopping")
    if (entry.state === "dead") return language.t("session.mathSwarm.state.dead")
    return language.t("session.mathSwarm.state.missing")
  }
  const detail = (entry: SessionMathWorkerEntry) => {
    const runtime = elapsed(entry)
    return [
      entry.pid ? `PID ${entry.pid}` : undefined,
      entry.round !== undefined ? language.t("session.mathSwarm.round", { round: entry.round }) : undefined,
      entry.last_fact_id ? `fact ${entry.last_fact_id.slice(0, 8)}` : undefined,
      entry.variant,
      entry.project,
      runtime ? language.t("session.mathSwarm.elapsed", { elapsed: runtime }) : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  }

  return (
    <Show when={props.available}>
      <div
        data-component="session-math-float"
        data-action="session-math-toggle-button"
        data-expanded={shown() ? "true" : "false"}
        class="absolute top-[100px] right-3 z-20 pointer-events-auto"
      >
        <Popover
          open={shown()}
          onOpenChange={setShown}
          triggerAs="button"
          triggerProps={{
            type: "button",
            "aria-label": shown()
              ? language.t("session.mathInitialize.collapse")
              : language.t("session.mathInitialize.expand"),
            class:
              "inline-flex items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-2 shadow-sm text-13-medium text-text-strong hover:bg-surface-raised-base-hover transition-colors",
          }}
          trigger={
            <>
              <Icon name="branch" size="small" class="text-icon-weak" />
              <Show when={running() > 0}>
                <span class="size-1.5 rounded-full bg-icon-success-base" />
              </Show>
              <span>{language.t("session.mathInitialize.button")}</span>
              <Show when={props.workers.length > 0}>
                <span class="font-mono text-11-regular text-text-weak">{props.workers.length}</span>
              </Show>
            </>
          }
          class="w-[520px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border-base bg-surface-raised-stronger p-0 shadow-xl"
          style={{ "max-height": "min(760px, calc(100dvh - 24px))" }}
          gutter={8}
          placement="bottom-end"
        >
          <div data-slot="session-math-float-panel" class="flex max-h-[min(760px,calc(100dvh-24px))] flex-col">
            <div class="flex items-center justify-between border-b border-border-weaker-base px-3 py-2">
              <div class="min-w-0">
                <div class="text-13-medium text-text-strong">{language.t("session.mathSwarm.details")}</div>
                <div class="text-11-regular text-text-weak">
                  {language.t("session.mathSwarm.summary", { running: running(), total: props.workers.length })}
                </div>
              </div>
              <div class="flex items-center gap-1">
                <Button size="small" variant="secondary" icon="plus" onClick={props.onInitialize}>
                  {language.t("session.mathSwarm.configure")}
                </Button>
                <IconButton
                  icon="close"
                  size="normal"
                  variant="ghost"
                  aria-label={language.t("session.mathInitialize.collapse")}
                  onClick={() => setShown(false)}
                />
              </div>
            </div>
            <div class="min-h-0 overflow-y-auto p-3">
              <Show when={projectSummary()}>
                {(summary) => (
                  <div class="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2">
                      <div class="text-11-regular text-text-weak">{language.t("session.mathSwarm.facts")}</div>
                      <div class="mt-0.5 font-mono text-16-medium text-text-strong">{summary().factCount ?? 0}</div>
                    </div>
                    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2">
                      <div class="text-11-regular text-text-weak">{language.t("session.mathSwarm.verified")}</div>
                      <div class="mt-0.5 font-mono text-16-medium text-text-success-base">
                        {summary().verificationCorrect ?? 0}
                      </div>
                    </div>
                    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2">
                      <div class="text-11-regular text-text-weak">{language.t("session.mathSwarm.wrong")}</div>
                      <div class="mt-0.5 font-mono text-16-medium text-text-warning-base">
                        {summary().verificationWrong ?? 0}
                      </div>
                    </div>
                    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2">
                      <div class="text-11-regular text-text-weak">{language.t("session.mathSwarm.errors")}</div>
                      <div class="mt-0.5 font-mono text-16-medium text-text-critical-base">
                        {summary().verificationError ?? 0}
                      </div>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={projectSummary()?.latestVerification}>
                {(latest) => (
                  <div class="mb-3 rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2">
                    <div class="text-11-medium text-text-weak">{language.t("session.mathSwarm.latestVerification")}</div>
                    <p class="mt-1 line-clamp-3 text-12-regular leading-5 text-text-strong">{latest()}</p>
                  </div>
                )}
              </Show>
              <Show
                when={props.workers.length > 0}
                fallback={
                  <div class="rounded-lg border border-dashed border-border-weak-base px-4 py-8 text-center">
                    <p class="text-13-medium text-text-strong">{language.t("session.mathSwarm.empty")}</p>
                    <p class="mt-1 text-12-regular text-text-weak">{language.t("session.mathSwarm.empty.description")}</p>
                    <Button class="mt-4" size="small" variant="primary" onClick={props.onInitialize}>
                      {language.t("session.mathInitialize.start")}
                    </Button>
                  </div>
                }
              >
                <div class="flex flex-col gap-2">
                  <For each={props.workers}>
                    {(entry) => (
                      <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
                        <div class="flex min-w-0 items-start justify-between gap-3">
                          <button class="min-w-0 flex-1 text-left" onClick={() => props.onOpen(entry)}>
                            <div class="flex min-w-0 items-center gap-2 text-13-medium text-text-strong">
                              <span class={`shrink-0 text-10-medium ${stateClass(entry)}`} aria-hidden="true">
                                ●
                              </span>
                              <span class="truncate">{entry.title}</span>
                              <span class={`shrink-0 text-11-medium ${stateClass(entry)}`}>{stateLabel(entry)}</span>
                            </div>
                            <div class="mt-1 truncate font-mono text-11-regular text-text-weak">{detail(entry)}</div>
                            <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-11-regular text-text-weak">
                              <Show when={compact(entry.tokens)}>
                                {(tokens) => <span>{language.t("session.mathSwarm.tokens", { tokens: tokens() })}</span>}
                              </Show>
                              <Show when={entry.cost !== undefined}>
                                <span>{language.t("session.mathSwarm.cost", { cost: (entry.cost ?? 0).toFixed(4) })}</span>
                              </Show>
                              <Show when={entry.last_rc !== undefined && entry.last_rc !== null}>
                                <span>rc {entry.last_rc}</span>
                              </Show>
                            </div>
                            <Show when={entry.taskPreview}>
                              <p class="mt-2 line-clamp-2 text-12-regular leading-5 text-text-weak">{entry.taskPreview}</p>
                            </Show>
                          </button>
                          <div class="flex shrink-0 items-center gap-1">
                            <Show when={entry.restartable && !entry.stopRequested}>
                              <Button
                                size="small"
                                variant="secondary"
                                disabled={busy(entry)}
                                onClick={() => props.onEnsure(entry)}
                              >
                                {language.t("session.mathSwarm.restart")}
                              </Button>
                            </Show>
                            <Show when={entry.stopRequested && !entry.alive}>
                              <Button
                                size="small"
                                variant="secondary"
                                disabled={busy(entry)}
                                onClick={() => props.onReEnable(entry)}
                              >
                                {language.t("session.mathSwarm.reEnable.short")}
                              </Button>
                            </Show>
                            <Show when={entry.alive && entry.state !== "stopping"}>
                              <Button
                                size="small"
                                variant="ghost"
                                class="text-text-critical-base"
                                disabled={busy(entry)}
                                onClick={() => props.onStop(entry)}
                              >
                                {language.t("session.mathSwarm.stop.short")}
                              </Button>
                            </Show>
                            <Button size="small" variant="ghost" disabled={busy(entry)} onClick={() => props.onTask(entry)}>
                              {language.t("session.mathSwarm.task")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Popover>
      </div>
    </Show>
  )
}
