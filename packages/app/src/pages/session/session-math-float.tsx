import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { For, Show, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopover, useBoundModelState } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import type { MathDetailKind, MathDetailPage, MathWorkerStatus } from "@/pages/session/math-worker-api"
import { SessionMathDetails } from "@/pages/session/session-math-details"
import { reconcileVerifierModelDraft } from "@/pages/session/math-verifier-model"

export type SessionMathWorkerEntry = MathWorkerStatus & { title: string }

type SessionMathFloatProps = {
  available: boolean
  initializing: boolean
  workers: SessionMathWorkerEntry[]
  busy: string[]
  onInitialize: () => void
  onOpen: (entry: SessionMathWorkerEntry) => void
  onEnsure: (entry: SessionMathWorkerEntry) => void
  onReEnable: (entry: SessionMathWorkerEntry) => void
  onStop: (entry: SessionMathWorkerEntry) => void
  onTask: (entry: SessionMathWorkerEntry) => void
  onOpenWorkerSession: (sessionID: string) => void
  onDetails: (kind: MathDetailKind, offset: number) => Promise<MathDetailPage>
  defaultVerifierModel: string
  onVerifierModelChange: (entry: SessionMathWorkerEntry, model: string) => Promise<void>
}

export function SessionMathFloat(props: SessionMathFloatProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const running = createMemo(() => props.workers.filter((worker) => worker.alive && worker.state === "running").length)
  const openMathMode = () => {
    if (props.workers.length === 0) {
      console.debug(`[math-swarm] open route=initialize initializing=${String(props.initializing)}`)
      if (!props.initializing) props.onInitialize()
      return
    }
    console.debug(`[math-swarm] open route=details workers=${props.workers.length}`)
    dialog.show(() => <SessionMathDialog {...props} />)
  }

  return (
    <Show when={props.available}>
      <div data-component="session-math-float" class="absolute top-[100px] right-3 z-20 pointer-events-auto">
        <button
          type="button"
          data-action="session-math-toggle-button"
          aria-busy={props.initializing ? "true" : undefined}
          class="inline-flex items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-2 shadow-sm text-13-medium text-text-strong hover:bg-surface-raised-base-hover transition-colors"
          onClick={(event) => {
            event.currentTarget.blur()
            openMathMode()
          }}
        >
          <Show when={props.initializing} fallback={<Icon name="branch" size="small" class="text-icon-weak" />}>
            <Spinner class="size-3.5 text-icon-weak" />
          </Show>
          <Show when={!props.initializing && running() > 0}>
            <span class="size-1.5 rounded-full bg-icon-success-base" />
          </Show>
          <span>
            {props.initializing
              ? language.t("session.mathInitialize.initializing")
              : language.t("session.mathInitialize.button")}
          </span>
          <Show when={!props.initializing && props.workers.length > 0}>
            <span class="font-mono text-11-regular text-text-weak">{props.workers.length}</span>
          </Show>
        </button>
      </div>
    </Show>
  )
}

function SessionMathDialog(props: SessionMathFloatProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const running = createMemo(() => props.workers.filter((worker) => worker.alive && worker.state === "running").length)
  const busy = (entry: SessionMathWorkerEntry) => props.busy.includes(entry.sessionID)
  const projectSummary = createMemo(() => props.workers[0])
  const [details, setDetails] = createStore({
    project: undefined as string | undefined,
    selected: undefined as MathDetailKind | undefined,
    page: undefined as MathDetailPage | undefined,
    loading: false,
    error: undefined as string | undefined,
  })
  let detailsRequest = 0
  const loadDetails = async (kind: MathDetailKind, offset: number) => {
    const request = ++detailsRequest
    const changingKind = details.selected !== kind
    console.debug(
      `[math-details] load start request=${request} project=${details.project ?? "none"} kind=${kind} offset=${offset}`,
    )
    setDetails({
      selected: kind,
      page: changingKind ? undefined : details.page,
      loading: true,
      error: undefined,
    })
    try {
      const page = await props.onDetails(kind, offset)
      if (request !== detailsRequest) {
        console.debug(`[math-details] load stale request=${request} current=${detailsRequest}`)
        return
      }
      console.debug(
        `[math-details] load finish request=${request} kind=${kind} offset=${page.offset} items=${page.items.length} total=${page.total}`,
      )
      setDetails({ page, loading: false, error: undefined })
    } catch (error) {
      if (request !== detailsRequest) return
      console.warn(
        `[math-details] load failed request=${request} project=${details.project ?? "none"} kind=${kind} offset=${offset} error=${error instanceof Error ? error.message : String(error)}`,
      )
      setDetails({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  createEffect(() => {
    const project = projectSummary()?.project
    if (project !== details.project) {
      detailsRequest += 1
      setDetails({ project, selected: undefined, page: undefined, loading: false, error: undefined })
      if (project) void loadDetails("facts", 0)
      return
    }
    const selected = details.selected
    const page = details.page
    if (!selected || !page || details.loading) return
    const summary = projectSummary()
    const expected =
      selected === "facts"
        ? summary?.factCount
        : selected === "correct"
          ? summary?.verificationCorrect
          : selected === "wrong"
            ? summary?.verificationWrong
            : summary?.verificationError
    if (expected === undefined || expected === page.total) return
    console.debug(
      `[math-details] summary changed project=${project ?? "none"} kind=${selected} previous=${page.total} next=${expected}`,
    )
    void loadDetails(selected, page.offset)
  })
  const selectDetails = (kind: MathDetailKind) => {
    if (details.selected === kind) {
      detailsRequest += 1
      setDetails({ selected: undefined, page: undefined, loading: false, error: undefined })
      return
    }
    void loadDetails(kind, 0)
  }
  const [verifier, setVerifier] = createStore({ model: "", persistedModel: "", saving: false })
  const verifierModel = useBoundModelState({
    value: () => verifier.model,
    onChange: (value) => {
      console.debug(
        `[math-swarm] verifier model draft changed previous=${verifier.model || "none"} next=${value || "none"} persisted=${verifier.persistedModel || "none"}`,
      )
      setVerifier("model", value)
    },
  })
  const selectedVerifierModel = createMemo(() => verifierModel.current())
  createEffect(() => {
    const next = projectSummary()?.verifierModel ?? props.defaultVerifierModel
    const reconciled = reconcileVerifierModelDraft({
      draft: verifier.model,
      persisted: verifier.persistedModel,
      nextPersisted: next,
    })
    if (!reconciled.changed) return
    console.debug(
      `[math-swarm] verifier model persisted sync previous=${verifier.persistedModel || "none"} next=${next} draft=${verifier.model || "none"} preserveDraft=${reconciled.preservedDraft}`,
    )
    setVerifier({ model: reconciled.model, persistedModel: reconciled.persistedModel })
  })
  const saveVerifierModel = async () => {
    const worker = projectSummary()
    const model = verifier.model.trim()
    if (!worker || !model.includes("/") || verifier.saving) return
    setVerifier("saving", true)
    try {
      await props.onVerifierModelChange(worker, model)
      setVerifier({ model, persistedModel: model })
    } finally {
      setVerifier("saving", false)
    }
  }
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
    if (entry.state === "dead") {
      return language.t(entry.stopRequested ? "session.mathSwarm.state.dead" : "session.mathSwarm.state.interrupted")
    }
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
    <>
      <style
        // eslint-disable-next-line solid/no-innerhtml
        innerHTML={`
          [data-component="dialog"][data-math-mode-dialog] [data-slot="dialog-container"] {
            display: flex;
            flex-direction: column;
          }
          [data-component="dialog"][data-math-mode-dialog] [data-slot="dialog-content"] {
            height: 100% !important;
            max-height: 100% !important;
            overflow: hidden !important;
          }
          [data-component="dialog"][data-math-mode-dialog] [data-slot="dialog-body"] {
            min-height: 0;
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
          }
        `}
      />
      <Dialog
        title={
          <div class="min-w-0">
            <div class="truncate">{language.t("session.mathSwarm.details")}</div>
            <div class="mt-0.5 text-12-regular text-text-weak">
              {props.initializing
                ? language.t("session.mathInitialize.initializing")
                : language.t("session.mathSwarm.summary", { running: running(), total: props.workers.length })}
            </div>
          </div>
        }
        size="x-large"
        transition
        containerStyle={{
          width: "min(calc(100vw - 32px), 1180px)",
          height: "min(calc(100vh - 32px), 88vh)",
          "max-height": "min(calc(100vh - 32px), 88vh)",
        }}
        data-math-mode-dialog
        action={
          <IconButton
            icon="close"
            size="large"
            variant="ghost"
            aria-label={language.t("session.mathInitialize.collapse")}
            onClick={() => dialog.close()}
          />
        }
      >
        <div
          data-component="session-math-dialog"
          class="grid h-full min-h-0 flex-1 grid-cols-[minmax(300px,0.8fr)_minmax(0,1.4fr)] gap-4 p-4"
        >
          <aside class="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div class="shrink-0 space-y-3">
              <Show when={projectSummary()}>
                <div class="rounded-xl border border-border-weak-base bg-surface-raised-base p-3 shadow-xs-border-base">
                  <div class="text-12-medium text-text-strong">{language.t("session.mathSwarm.verifierModel")}</div>
                  <div class="mt-2 flex items-center gap-2">
                    <ModelSelectorPopover
                      model={verifierModel}
                      debugName="math-verifier-model"
                      style={{ "z-index": 60 }}
                      onOpenChange={(next) =>
                        console.debug(`[math-swarm] verifier model menu open change next=${next} dialog=true`)
                      }
                      triggerAs={Button}
                      triggerProps={{
                        type: "button",
                        variant: "secondary",
                        class: "min-w-0 flex-1 justify-between",
                      }}
                    >
                      <div class="flex min-w-0 items-center gap-2">
                        <Show when={selectedVerifierModel()?.provider.id}>
                          <ProviderIcon id={selectedVerifierModel()!.provider.id} class="size-4 shrink-0" />
                        </Show>
                        <span class="truncate">
                          {selectedVerifierModel()
                            ? `${selectedVerifierModel()!.provider.name} / ${selectedVerifierModel()!.name}`
                            : verifier.model || language.t("dialog.model.select.title")}
                        </span>
                      </div>
                      <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
                    </ModelSelectorPopover>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={
                        verifier.saving || !verifier.model.includes("/") || verifier.model === verifier.persistedModel
                      }
                      onClick={() => void saveVerifierModel()}
                    >
                      <Show when={verifier.saving} fallback={language.t("session.mathSwarm.verifierModel.save")}>
                        <Spinner class="size-3.5" />
                      </Show>
                    </Button>
                  </div>
                  <p class="mt-2 text-11-regular text-text-weak">
                    {language.t("session.mathSwarm.verifierModel.description")}
                  </p>
                </div>
              </Show>
              <Show when={projectSummary()?.latestVerification}>
                {(latest) => (
                  <div class="rounded-xl border border-border-weak-base bg-surface-raised-base px-3 py-2.5 shadow-xs-border-base">
                    <div class="text-11-medium text-text-weak">
                      {language.t("session.mathSwarm.latestVerification")}
                    </div>
                    <p class="mt-1 line-clamp-3 text-12-regular leading-5 text-text-strong">{latest()}</p>
                  </div>
                )}
              </Show>
            </div>
            <section class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              <div class="flex shrink-0 items-center justify-between gap-2">
                <div class="text-12-medium text-text-base">{language.t("session.mathSwarm.label")}</div>
                <span class="font-mono text-11-regular text-text-weak">{props.workers.length}</span>
              </div>
              <Show
                when={props.workers.length > 0}
                fallback={
                  <Show
                    when={props.initializing}
                    fallback={
                      <div class="rounded-lg border border-dashed border-border-weak-base px-4 py-8 text-center">
                        <p class="text-13-medium text-text-strong">{language.t("session.mathSwarm.empty")}</p>
                        <p class="mt-1 text-12-regular text-text-weak">
                          {language.t("session.mathSwarm.empty.description")}
                        </p>
                        <Button class="mt-4" size="small" variant="primary" onClick={props.onInitialize}>
                          {language.t("session.mathInitialize.start")}
                        </Button>
                      </div>
                    }
                  >
                    <div
                      data-slot="session-math-initializing"
                      aria-live="polite"
                      aria-busy="true"
                      class="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-weak-base px-4 py-12 text-center"
                    >
                      <Spinner class="size-5 text-icon-weak" />
                      <p class="text-13-medium text-text-strong">{language.t("session.mathInitialize.initializing")}</p>
                    </div>
                  </Show>
                }
              >
                <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  <For each={props.workers}>
                    {(entry) => (
                      <div class="rounded-xl border border-border-weak-base bg-surface-raised-base p-3 shadow-xs-border-base">
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
                                {(tokens) => (
                                  <span>{language.t("session.mathSwarm.tokens", { tokens: tokens() })}</span>
                                )}
                              </Show>
                              <Show when={entry.cost !== undefined}>
                                <span>
                                  {language.t("session.mathSwarm.cost", { cost: (entry.cost ?? 0).toFixed(4) })}
                                </span>
                              </Show>
                              <Show when={entry.last_rc !== undefined && entry.last_rc !== null}>
                                <span>rc {entry.last_rc}</span>
                              </Show>
                            </div>
                            <Show when={entry.taskPreview}>
                              <p class="mt-2 line-clamp-2 text-12-regular leading-5 text-text-weak">
                                {entry.taskPreview}
                              </p>
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
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={busy(entry)}
                              onClick={() => props.onTask(entry)}
                            >
                              {language.t("session.mathSwarm.task")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </aside>
          <main class="min-h-0 overflow-hidden rounded-xl border border-border-weak-base bg-surface-raised-base shadow-xs-border-base">
            <Show
              when={projectSummary()}
              fallback={
                <div class="flex h-full items-center justify-center px-6 text-center text-12-regular text-text-weak">
                  {language.t("session.mathSwarm.empty.description")}
                </div>
              }
            >
              {(summary) => (
                <SessionMathDetails
                  summary={summary()}
                  selected={details.selected}
                  page={details.page}
                  loading={details.loading}
                  error={details.error}
                  onSelect={selectDetails}
                  onOffset={(offset) => {
                    const kind = details.selected
                    if (!kind) return
                    void loadDetails(kind, offset)
                  }}
                  onOpenWorker={props.onOpenWorkerSession}
                />
              )}
            </Show>
          </main>
        </div>
      </Dialog>
    </>
  )
}
