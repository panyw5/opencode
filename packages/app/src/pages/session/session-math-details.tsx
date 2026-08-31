import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Markdown } from "@opencode-ai/ui/markdown"
import { Spinner } from "@opencode-ai/ui/spinner"
import { For, Show, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import type {
  MathDetailItem,
  MathDetailKind,
  MathDetailPage,
  MathFactDetail,
  MathVerificationDetail,
  MathWorkerStatus,
} from "@/pages/session/math-worker-api"

const pageSize = 20

function titleClass(kind: MathDetailKind) {
  if (kind === "correct") return "text-text-success-base"
  if (kind === "wrong") return "text-text-warning-base"
  if (kind === "error") return "text-text-critical-base"
  return "text-text-strong"
}

function count(summary: MathWorkerStatus, kind: MathDetailKind) {
  if (kind === "facts") return summary.factCount ?? 0
  if (kind === "correct") return summary.verificationCorrect ?? 0
  if (kind === "wrong") return summary.verificationWrong ?? 0
  return summary.verificationError ?? 0
}

function MathDetailCard(props: {
  kind: MathDetailKind
  label: string
  count: number
  selected: boolean
  loading: boolean
  loadingLabel: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-slot={`math-detail-card-${props.kind}`}
      aria-pressed={props.selected}
      class="relative overflow-hidden rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:border-border-strong-base hover:bg-surface-interactive-weak focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-base"
      classList={{
        "border-[color-mix(in_srgb,var(--surface-brand-base)_58%,var(--border-base))] bg-[linear-gradient(110deg,color-mix(in_srgb,var(--surface-brand-base)_20%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-base)_7%,var(--background-base)))] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--surface-brand-base)_22%,transparent),0_10px_24px_-16px_color-mix(in_srgb,var(--surface-brand-base)_70%,transparent)]":
          props.selected,
      }}
      onClick={props.onSelect}
    >
      <div class="flex items-center justify-between gap-2">
        <div
          class="text-11-regular"
          classList={{ "text-text-strong": props.selected, "text-text-weak": !props.selected }}
        >
          {props.label}
        </div>
        <Show when={props.selected && props.loading}>
          <span role="status" aria-live="polite" class="inline-flex items-center">
            <Spinner class="size-3 text-icon-weak" />
            <span class="sr-only">{props.loadingLabel}</span>
          </span>
        </Show>
      </div>
      <div class={`mt-0.5 font-mono text-16-medium ${titleClass(props.kind)}`}>{props.count}</div>
      <Show when={props.selected}>
        <span class="absolute inset-y-2 left-0 w-1 rounded-r-full bg-surface-brand-base" aria-hidden="true" />
      </Show>
    </button>
  )
}

function FactBody(props: { item: MathFactDetail }) {
  const language = useLanguage()
  return (
    <div class="space-y-3 border-t border-border-weaker-base px-3 py-3">
      <section>
        <div class="mb-1 text-11-medium text-text-weak">{language.t("session.mathSwarm.details.proof")}</div>
        <Markdown text={props.item.proof} math="defer" class="text-12-regular leading-5 text-text-strong" />
      </section>
      <Show when={props.item.intuition}>
        {(intuition) => (
          <section>
            <div class="mb-1 text-11-medium text-text-weak">{language.t("session.mathSwarm.details.intuition")}</div>
            <Markdown text={intuition()} math="defer" class="text-12-regular leading-5 text-text-strong" />
          </section>
        )}
      </Show>
      <Show when={props.item.predecessors.length > 0}>
        <section>
          <div class="mb-1.5 text-11-medium text-text-weak">{language.t("session.mathSwarm.details.predecessors")}</div>
          <div class="flex flex-wrap gap-1.5">
            <For each={props.item.predecessors}>
              {(factID) => (
                <code class="rounded bg-surface-base px-1.5 py-0.5 font-mono text-11-regular text-text-weak">
                  {factID}
                </code>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  )
}

function VerificationBody(props: { item: MathVerificationDetail; onOpenWorker: (sessionID: string) => void }) {
  const language = useLanguage()
  return (
    <div class="space-y-3 border-t border-border-weaker-base px-3 py-3">
      <Show
        when={props.item.proof}
        fallback={
          <div class="rounded-md border border-border-weaker-base bg-surface-base px-2.5 py-2 text-12-regular text-text-weak">
            {language.t("session.mathSwarm.details.proofUnavailable")}
          </div>
        }
      >
        {(proof) => (
          <section>
            <div class="mb-1 text-11-medium text-text-weak">{language.t("session.mathSwarm.details.proof")}</div>
            <Markdown text={proof()} math="defer" class="text-12-regular leading-5 text-text-strong" />
          </section>
        )}
      </Show>
      <Show when={props.item.report}>
        {(report) => (
          <section>
            <div class="mb-1 text-11-medium text-text-weak">{language.t("session.mathSwarm.details.report")}</div>
            <Markdown text={report().summary} math="defer" class="text-12-regular leading-5 text-text-strong" />
            <Show when={report().criticalErrors.length > 0}>
              <div class="mt-2 text-11-medium text-text-critical-base">
                {language.t("session.mathSwarm.details.criticalErrors")}
              </div>
              <ul class="mt-1 list-disc space-y-1 pl-4 text-12-regular leading-5 text-text-strong">
                <For each={report().criticalErrors}>{(item) => <li>{item}</li>}</For>
              </ul>
            </Show>
            <Show when={report().gaps.length > 0}>
              <div class="mt-2 text-11-medium text-text-warning-base">
                {language.t("session.mathSwarm.details.gaps")}
              </div>
              <ul class="mt-1 list-disc space-y-1 pl-4 text-12-regular leading-5 text-text-strong">
                <For each={report().gaps}>{(item) => <li>{item}</li>}</For>
              </ul>
            </Show>
          </section>
        )}
      </Show>
      <Show when={props.item.evidence}>
        {(evidence) => (
          <section>
            <div class="mb-1 text-11-medium text-text-weak">{language.t("session.mathSwarm.details.evidence")}</div>
            <p class="whitespace-pre-wrap text-12-regular leading-5 text-text-strong">{evidence()}</p>
          </section>
        )}
      </Show>
      <Show when={props.item.error || props.item.writeError}>
        <div
          role="alert"
          class="rounded-md bg-surface-critical-weak px-2.5 py-2 text-12-regular text-text-critical-base"
        >
          {props.item.error ?? props.item.writeError}
        </div>
      </Show>
      <Show when={props.item.workerSessionID}>
        {(sessionID) => (
          <Button size="small" variant="secondary" onClick={() => props.onOpenWorker(sessionID())}>
            {language.t("session.mathSwarm.details.openWorker")}
          </Button>
        )}
      </Show>
    </div>
  )
}

function MathDetailRow(props: { item: MathDetailItem; onOpenWorker: (sessionID: string) => void }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const verdictLabel = () => {
    if (props.item.kind === "correct") return language.t("session.mathSwarm.verified")
    if (props.item.kind === "wrong") return language.t("session.mathSwarm.wrong")
    if (props.item.kind === "error") return language.t("session.mathSwarm.errors")
    return props.item.factId
  }
  const timestamp = () => {
    if (props.item.kind === "fact") return undefined
    const value = new Date(props.item.timestamp)
    if (Number.isNaN(value.getTime())) return props.item.timestamp
    return value.toLocaleString(language.intl())
  }
  return (
    <Collapsible
      data-slot="math-detail-record"
      variant="ghost"
      open={open()}
      onOpenChange={setOpen}
      class="overflow-hidden rounded-lg border border-border-weak-base bg-surface-raised-base"
    >
      <Collapsible.Trigger
        class="w-full px-3 py-2.5 text-left hover:bg-surface-interactive-weak focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-base"
        style={{ height: "auto" }}
      >
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div
              class={`text-11-medium ${props.item.kind === "fact" ? "text-text-weak" : titleClass(props.item.kind)}`}
            >
              {verdictLabel()}
            </div>
            <p class="mt-1 line-clamp-2 text-12-regular leading-5 text-text-strong">{props.item.statement}</p>
            <Show when={timestamp()}>
              {(value) => <div class="mt-1 text-11-regular text-text-weak">{value()}</div>}
            </Show>
          </div>
          <Collapsible.Arrow class="mt-0.5 shrink-0" style={{ opacity: 1 }} />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Show
          when={props.item.kind === "fact" ? props.item : undefined}
          fallback={<VerificationBody item={props.item as MathVerificationDetail} onOpenWorker={props.onOpenWorker} />}
        >
          {(item) => <FactBody item={item()} />}
        </Show>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function SessionMathDetails(props: {
  summary: MathWorkerStatus
  selected?: MathDetailKind
  page?: MathDetailPage
  loading: boolean
  error?: string
  onSelect: (kind: MathDetailKind) => void
  onOffset: (offset: number) => void
  onOpenWorker: (sessionID: string) => void
}) {
  const language = useLanguage()
  const label = (kind: MathDetailKind) => {
    if (kind === "facts") return language.t("session.mathSwarm.facts")
    if (kind === "correct") return language.t("session.mathSwarm.verified")
    if (kind === "wrong") return language.t("session.mathSwarm.wrong")
    return language.t("session.mathSwarm.errors")
  }
  const end = () => Math.min((props.page?.offset ?? 0) + (props.page?.items.length ?? 0), props.page?.total ?? 0)

  return (
    <div class="flex h-full min-h-0 flex-col p-4">
      <div class="grid shrink-0 grid-cols-4 gap-2">
        <For each={["facts", "correct", "wrong", "error"] as const}>
          {(kind) => (
            <MathDetailCard
              kind={kind}
              label={label(kind)}
              count={count(props.summary, kind)}
              selected={props.selected === kind}
              loading={props.loading && props.selected === kind}
              loadingLabel={language.t("session.mathSwarm.details.loading")}
              onSelect={() => props.onSelect(kind)}
            />
          )}
        </For>
      </div>
      <Show when={props.selected}>
        <section
          data-slot="math-detail-list"
          aria-busy={props.loading}
          class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <Show when={props.error}>
            <div
              role="alert"
              class="rounded-lg bg-surface-critical-weak px-3 py-2 text-12-regular text-text-critical-base"
            >
              {language.t("session.mathSwarm.details.loadError")}
            </div>
          </Show>
          <Show when={props.loading && !props.page}>
            <div
              aria-live="polite"
              class="flex items-center justify-center gap-2 rounded-lg border border-border-weaker-base px-3 py-8 text-12-regular text-text-weak"
            >
              <Spinner class="size-4" />
              {language.t("session.mathSwarm.details.loading")}
            </div>
          </Show>
          <Show when={!props.loading && !props.error && props.page?.items.length === 0}>
            <div class="rounded-lg border border-dashed border-border-weak-base px-3 py-8 text-center text-12-regular text-text-weak">
              {language.t("session.mathSwarm.details.empty")}
            </div>
          </Show>
          <Show when={props.page?.items.length}>
            <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              <For each={props.page?.items}>
                {(item) => <MathDetailRow item={item} onOpenWorker={props.onOpenWorker} />}
              </For>
            </div>
          </Show>
          <Show when={(props.page?.total ?? 0) > pageSize}>
            <div class="mt-2 flex shrink-0 items-center justify-between gap-2 border-t border-border-weaker-base pt-2">
              <span class="text-11-regular text-text-weak">
                {language.t("session.mathSwarm.details.range", {
                  start: (props.page?.offset ?? 0) + 1,
                  end: end(),
                  total: props.page?.total ?? 0,
                })}
              </span>
              <div class="flex items-center gap-1">
                <Button
                  size="small"
                  variant="secondary"
                  disabled={props.loading || (props.page?.offset ?? 0) === 0}
                  onClick={() => props.onOffset(Math.max(0, (props.page?.offset ?? 0) - pageSize))}
                >
                  {language.t("session.mathSwarm.details.previous")}
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={props.loading || end() >= (props.page?.total ?? 0)}
                  onClick={() => props.onOffset((props.page?.offset ?? 0) + pageSize)}
                >
                  {language.t("session.mathSwarm.details.next")}
                </Button>
              </div>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  )
}
