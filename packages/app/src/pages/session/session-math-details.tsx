import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { Spinner } from "@opencode-ai/ui/spinner"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import type {
  MathDetailItem,
  MathDetailKind,
  MathDetailPage,
  MathFactGraph,
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

type PositionedFact = MathFactDetail & { x: number; y: number; level: number }

const factNodeWidth = 214
const factNodeHeight = 120
const factColumnGap = 72
const factRowGap = 30

function layoutFactGraph(graph: MathFactGraph) {
  const byID = new Map(graph.nodes.map((node) => [node.factId, node]))
  const levels = new Map<string, number>()
  const visiting = new Set<string>()
  const levelOf = (factID: string): number => {
    const cached = levels.get(factID)
    if (cached !== undefined) return cached
    if (visiting.has(factID)) return 0
    const node = byID.get(factID)
    if (!node) return 0
    visiting.add(factID)
    const level = node.predecessors.reduce((max, predecessor) => Math.max(max, levelOf(predecessor) + 1), 0)
    visiting.delete(factID)
    levels.set(factID, level)
    return level
  }
  for (const node of graph.nodes) levelOf(node.factId)

  const groups = new Map<number, MathFactDetail[]>()
  for (const node of graph.nodes) {
    const level = levels.get(node.factId) ?? 0
    const group = groups.get(level)
    if (group) group.push(node)
    else groups.set(level, [node])
  }
  const positions = new Map<string, PositionedFact>()
  const maxLevel = Math.max(...levels.values(), 0)
  for (let level = 0; level <= maxLevel; level += 1) {
    const group = groups.get(level) ?? []
    const sorted = group.toSorted((a, b) => {
      const center = (node: MathFactDetail) => {
        const parentPositions = node.predecessors.map((id) => positions.get(id)).filter(Boolean)
        if (parentPositions.length === 0) return Number.POSITIVE_INFINITY
        return parentPositions.reduce((sum, parent) => sum + parent!.y, 0) / parentPositions.length
      }
      return center(a) - center(b) || a.factId.localeCompare(b.factId)
    })
    let cursor = 24
    for (const node of sorted) {
      const parentPositions = node.predecessors.map((id) => positions.get(id)).filter(Boolean)
      const desired =
        parentPositions.length > 0
          ? parentPositions.reduce((sum, parent) => sum + parent!.y, 0) / parentPositions.length
          : cursor
      const y = Math.max(cursor, desired)
      positions.set(node.factId, {
        ...node,
        level,
        x: 24 + level * (factNodeWidth + factColumnGap),
        y,
      })
      cursor = y + factNodeHeight + factRowGap
    }
  }
  const positioned = graph.nodes.flatMap((node) => {
    const position = positions.get(node.factId)
    return position ? [position] : []
  })
  const edges = graph.edges.flatMap((edge) => {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    return from && to ? [{ from, to }] : []
  })
  const width = Math.max(520, (maxLevel + 1) * (factNodeWidth + factColumnGap) + 24)
  const height = Math.max(220, Math.max(...positioned.map((node) => node.y + factNodeHeight), 0) + 24)
  return { nodes: positioned, edges, width, height }
}

function MathDetailCard(props: {
  kind: MathDetailKind
  label: string
  count: number
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-slot={`math-detail-card-${props.kind}`}
      aria-pressed={props.selected}
      class="relative inline-flex shrink-0 items-center justify-between gap-2 overflow-hidden rounded-full border border-border-weak-base bg-background-base px-3 py-1.5 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:border-border-strong-base hover:bg-surface-interactive-weak focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-base"
      classList={{
        "border-[color-mix(in_srgb,var(--surface-brand-base)_58%,var(--border-base))] bg-[linear-gradient(110deg,color-mix(in_srgb,var(--surface-brand-base)_20%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-base)_7%,var(--background-base)))] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--surface-brand-base)_22%,transparent)]":
          props.selected,
      }}
      onClick={props.onSelect}
    >
      <span
        class="text-12-medium"
        classList={{ "text-text-strong": props.selected, "text-text-weak": !props.selected }}
      >
        {props.label}
      </span>
      <span class={`font-mono text-13-medium ${titleClass(props.kind)}`}>{props.count}</span>
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

function VerifiedFactGraph(props: {
  graph: MathFactGraph
  selectedFactID?: string
  onSelect: (fact: MathFactDetail) => void
  onClose: () => void
}) {
  const language = useLanguage()
  const graph = createMemo(() => layoutFactGraph(props.graph))
  const selected = () => props.graph.nodes.find((node) => node.factId === props.selectedFactID)
  const [transform, setTransform] = createSignal({ x: 0, y: 0, scale: 1 })
  const [dragging, setDragging] = createSignal(false)
  const [hasCustomView, setHasCustomView] = createSignal(false)
  let viewport: HTMLDivElement | undefined
  let graphKey = ""
  let dragStart: { pointerX: number; pointerY: number; x: number; y: number } | undefined

  const focusGraph = () => {
    if (!viewport) return
    const current = graph()
    const scale = 1
    setTransform({
      scale,
      x: 24,
      y: Math.max(24, (viewport.clientHeight - current.height * scale) / 2),
    })
    console.debug(
      `[math-fact-graph] initial focus nodes=${current.nodes.length} edges=${current.edges.length} scale=${scale.toFixed(2)}`,
    )
  }

  const fit = () => {
    if (!viewport) return
    const current = graph()
    const availableWidth = Math.max(1, viewport.clientWidth - 24)
    const availableHeight = Math.max(1, viewport.clientHeight - 24)
    const scale = Math.min(
      1,
      Math.max(0.28, Math.min(availableWidth / current.width, availableHeight / current.height)),
    )
    setTransform({
      scale,
      x: (viewport.clientWidth - current.width * scale) / 2,
      y: (viewport.clientHeight - current.height * scale) / 2,
    })
    console.debug(
      `[math-fact-graph] fit nodes=${current.nodes.length} edges=${current.edges.length} scale=${scale.toFixed(2)}`,
    )
  }

  const zoom = (
    nextScale: number,
    centerX = (viewport?.clientWidth ?? 0) / 2,
    centerY = (viewport?.clientHeight ?? 0) / 2,
  ) => {
    const current = transform()
    const scale = Math.min(2.5, Math.max(0.28, nextScale))
    const worldX = (centerX - current.x) / current.scale
    const worldY = (centerY - current.y) / current.scale
    setTransform({ scale, x: centerX - worldX * scale, y: centerY - worldY * scale })
    setHasCustomView(true)
    console.debug(`[math-fact-graph] zoom scale=${scale.toFixed(2)}`)
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const factor = Math.exp(-event.deltaY * 0.001)
    zoom(transform().scale * factor, event.clientX - rect.left, event.clientY - rect.top)
  }

  const onPointerDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return
    const current = transform()
    dragStart = { pointerX: event.clientX, pointerY: event.clientY, x: current.x, y: current.y }
    setDragging(true)
    event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!dragStart) return
    setTransform({
      ...transform(),
      x: dragStart.x + event.clientX - dragStart.pointerX,
      y: dragStart.y + event.clientY - dragStart.pointerY,
    })
    setHasCustomView(true)
  }

  const onPointerUp = (event: PointerEvent) => {
    dragStart = undefined
    setDragging(false)
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  onMount(() => {
    focusGraph()
    const observer = new ResizeObserver(() => {
      if (!hasCustomView()) focusGraph()
    })
    if (viewport) observer.observe(viewport)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const current = graph()
    const nextKey = `${current.nodes.length}:${current.edges.length}:${current.width}:${current.height}`
    if (nextKey === graphKey) return
    graphKey = nextKey
    setHasCustomView(false)
    queueMicrotask(focusGraph)
  })

  return (
    <>
      <style>{`@keyframes math-fact-preview-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div class="flex min-h-0 flex-1 flex-col gap-3">
        <div
          ref={(element) => {
            viewport = element
          }}
          class="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border-weaker-base bg-[radial-gradient(circle_at_1px_1px,color-mix(in_srgb,var(--border-weak-base)_55%,transparent)_1px,transparent_0)_0_0/20px_20px] bg-background-base touch-none select-none"
          classList={{ "cursor-grabbing": dragging(), "cursor-grab": !dragging() }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div class="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg border border-border-weak-base bg-surface-raised-base/95 p-1 shadow-xs-border-base backdrop-blur-sm">
            <button
              type="button"
              class="rounded px-2 py-1 text-11-medium text-text-weak hover:bg-surface-interactive-weak"
              aria-label={language.t("session.mathSwarm.details.zoomOut")}
              onClick={() => zoom(transform().scale - 0.15)}
            >
              −
            </button>
            <span class="min-w-10 text-center font-mono text-10-regular text-text-weak">
              {Math.round(transform().scale * 100)}%
            </span>
            <button
              type="button"
              class="rounded px-2 py-1 text-11-medium text-text-weak hover:bg-surface-interactive-weak"
              aria-label={language.t("session.mathSwarm.details.zoomIn")}
              onClick={() => zoom(transform().scale + 0.15)}
            >
              +
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 text-11-medium text-text-weak hover:bg-surface-interactive-weak"
              aria-label={language.t("session.mathSwarm.details.fitGraph")}
              onClick={() => {
                setHasCustomView(false)
                fit()
              }}
            >
              {language.t("session.mathSwarm.details.fitGraph")}
            </button>
          </div>
          <div
            class="absolute"
            style={{
              width: `${graph().width}px`,
              height: `${graph().height}px`,
              transform: `translate(${transform().x}px, ${transform().y}px) scale(${transform().scale})`,
              "transform-origin": "0 0",
            }}
          >
            <svg
              class="pointer-events-none absolute inset-0"
              width={graph().width}
              height={graph().height}
              aria-hidden="true"
            >
              <defs>
                <marker id="math-fact-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--icon-weak-base)" />
                </marker>
              </defs>
              <For each={graph().edges}>
                {(edge) => (
                  <path
                    d={`M ${edge.from.x + factNodeWidth} ${edge.from.y + factNodeHeight / 2} C ${edge.from.x + factNodeWidth + 36} ${edge.from.y + factNodeHeight / 2}, ${edge.to.x - 36} ${edge.to.y + factNodeHeight / 2}, ${edge.to.x} ${edge.to.y + factNodeHeight / 2}`}
                    fill="none"
                    stroke="var(--border-weak-base)"
                    stroke-width="1.5"
                    marker-end="url(#math-fact-arrow)"
                  />
                )}
              </For>
            </svg>
            <For each={graph().nodes}>
              {(node) => (
                <button
                  type="button"
                  aria-pressed={props.selectedFactID === node.factId}
                  aria-label={node.statement}
                  class="absolute rounded-xl border border-border-weak-base bg-surface-raised-base px-3 py-2 text-left shadow-xs-border-base transition-[border-color,background-color,box-shadow] hover:border-border-strong-base hover:bg-surface-interactive-weak focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-base"
                  classList={{
                    "border-[color-mix(in_srgb,var(--surface-brand-base)_65%,var(--border-base))] bg-[color-mix(in_srgb,var(--surface-brand-base)_12%,var(--surface-raised-base))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--surface-brand-base)_20%,transparent)]":
                      props.selectedFactID === node.factId,
                  }}
                  style={{
                    left: `${node.x}px`,
                    top: `${node.y}px`,
                    width: `${factNodeWidth}px`,
                    height: `${factNodeHeight}px`,
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    console.debug(`[math-fact-graph] node selected fact=${node.factId}`)
                    props.onSelect(node)
                  }}
                >
                  <div class="flex items-center justify-end gap-2">
                    <span class="font-mono text-10-regular text-text-weak">{node.factId.slice(0, 8)}</span>
                  </div>
                  <div class="mt-1 line-clamp-4 text-12-regular leading-4 text-text-strong">{node.statement}</div>
                </button>
              )}
            </For>
          </div>
        </div>
        <Show when={selected()}>
          {(fact) => (
            <div
              class="max-h-[42%] shrink-0 overflow-y-auto rounded-lg border border-border-weak-base bg-surface-raised-base"
              style={{ animation: "math-fact-preview-in 180ms cubic-bezier(0.16, 1, 0.3, 1)" }}
            >
              <div class="flex items-center justify-between gap-2 px-3 pt-2.5">
                <div class="text-11-medium text-text-weak">{language.t("session.mathSwarm.details.statement")}</div>
                <IconButton
                  icon="close"
                  size="small"
                  variant="ghost"
                  aria-label={language.t("common.close")}
                  onClick={props.onClose}
                />
              </div>
              <section class="px-3 pb-3">
                <Markdown text={fact().statement} math="defer" class="text-12-regular leading-5 text-text-strong" />
              </section>
              <FactBody item={fact()} />
            </div>
          )}
        </Show>
      </div>
    </>
  )
}

export function SessionMathDetails(props: {
  summary: MathWorkerStatus
  selected?: MathDetailKind
  page?: MathDetailPage
  loading: boolean
  error?: string
  factGraph?: MathFactGraph
  graphLoading: boolean
  graphError?: string
  onSelect: (kind: MathDetailKind) => void
  onOffset: (offset: number) => void
  onOpenWorker: (sessionID: string) => void
  onGraph: () => void
}) {
  const language = useLanguage()
  const [factView, setFactView] = createSignal<"list" | "graph">("graph")
  const [selectedFactID, setSelectedFactID] = createSignal<string>()
  const label = (kind: MathDetailKind) => {
    if (kind === "facts") return language.t("session.mathSwarm.facts")
    if (kind === "correct") return language.t("session.mathSwarm.verified")
    if (kind === "wrong") return language.t("session.mathSwarm.wrong")
    return language.t("session.mathSwarm.errors")
  }
  const end = () => Math.min((props.page?.offset ?? 0) + (props.page?.items.length ?? 0), props.page?.total ?? 0)

  return (
    <div class="flex h-full min-h-0 flex-col p-4">
      <div class="flex shrink-0 items-center gap-2 overflow-x-auto">
        <For each={["facts", "correct", "wrong", "error"] as const}>
          {(kind) => (
            <MathDetailCard
              kind={kind}
              label={label(kind)}
              count={count(props.summary, kind)}
              selected={props.selected === kind}
              onSelect={() => props.onSelect(kind)}
            />
          )}
        </For>
      </div>
      <Show when={props.selected === "facts"}>
        <div class="mt-3 flex shrink-0 items-center justify-between gap-2">
          <div class="text-11-regular text-text-weak">{language.t("session.mathSwarm.details.factView")}</div>
          <div class="flex items-center gap-1 rounded-md border border-border-weak-base bg-background-base p-0.5">
            <For each={["list", "graph"] as const}>
              {(view) => (
                <button
                  type="button"
                  aria-pressed={factView() === view}
                  class="rounded px-2 py-1 text-11-medium text-text-weak hover:bg-surface-interactive-weak"
                  classList={{ "bg-surface-raised-base text-text-strong shadow-xs-border-base": factView() === view }}
                  onClick={() => {
                    setFactView(view)
                    if (view === "graph" && !props.factGraph && !props.graphLoading) props.onGraph()
                  }}
                >
                  {view === "list"
                    ? language.t("session.mathSwarm.details.listView")
                    : language.t("session.mathSwarm.details.graphView")}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={props.selected}>
        <section
          data-slot="math-detail-list"
          aria-busy={props.loading}
          class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <Show when={props.selected === "facts" && factView() === "graph"}>
            <Show
              when={!props.graphLoading && !props.graphError && props.factGraph}
              fallback={
                <div class="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border-weak-base px-3 py-8 text-12-regular text-text-weak">
                  <Show
                    when={props.graphLoading}
                    fallback={props.graphError ?? language.t("session.mathSwarm.details.empty")}
                  >
                    <Spinner class="size-4" />
                    {language.t("session.mathSwarm.details.loading")}
                  </Show>
                </div>
              }
            >
              {(graph) => (
                <VerifiedFactGraph
                  graph={graph()}
                  selectedFactID={selectedFactID()}
                  onSelect={(fact) => setSelectedFactID(fact.factId)}
                  onClose={() => setSelectedFactID(undefined)}
                />
              )}
            </Show>
          </Show>
          <Show when={factView() === "list" || props.selected !== "facts"}>
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
          </Show>
        </section>
      </Show>
    </div>
  )
}
