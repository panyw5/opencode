import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, getOwner, JSX, runWithOwner, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal, type ModelKey } from "@/context/local"
import { useModels } from "@/context/models"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { compareProviderGroups } from "./provider-order"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { DialogSelectProvider } from "./dialog-select-provider"
import { DialogManageModels } from "./dialog-manage-models"
import { ModelTooltip } from "./model-tooltip"
import { modelProviderIconID } from "./model-provider-icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

function dbg() {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem("opencode.ui.debug") === "1"
  } catch {
    return false
  }
}

function logModelOpen(_kind: string, _fields: Record<string, string | number | boolean | undefined>) {
}

function logStage(_stage: string, _fields: Record<string, string | number | boolean | undefined>) {
}

function since(at: number) {
  return at ? Math.round(performance.now() - at) : "none"
}

function rect(el: HTMLElement | undefined) {
  if (!el) return
  const box = el.getBoundingClientRect()
  return {
    width: Math.round(box.width),
    height: Math.round(box.height),
    top: Math.round(box.top),
    left: Math.round(box.left),
  }
}

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

export type ModelState = ReturnType<typeof useLocal>["model"]

/** Parse `provider/model` config refs (first slash separates provider from model id). */
export function parseModelRef(raw: string): ModelKey | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const idx = value.indexOf("/")
  if (idx <= 0 || idx >= value.length - 1) return undefined
  return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) }
}

/**
 * Bound model state for settings forms.
 * Reuses the session model picker (ModelSelectorPopover / DialogSelectModel)
 * without writing into the session-local selection.
 */
export function useBoundModelState(input: {
  value: () => string
  onChange: (next: string) => void
}): ModelState {
  const models = useModels()

  const key = createMemo(() => parseModelRef(input.value()))
  const current = () => {
    const item = key()
    if (!item) return undefined
    return models.find(item)
  }
  const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

  const set = (item: ModelKey | undefined, options?: { recent?: boolean }) => {
    if (!item) {
      input.onChange("")
      return
    }
    input.onChange(`${item.providerID}/${item.modelID}`)
    models.setVisibility(item, true)
    if (options?.recent) models.recent.push(item)
  }

  return {
    ready: models.ready,
    current,
    recent,
    list: models.list,
    cycle(direction) {
      const items = recent()
      const item = current()
      if (!item || items.length === 0) return
      const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
      if (index === -1) return
      let next = index + direction
      if (next < 0) next = items.length - 1
      if (next >= items.length) next = 0
      const entry = items[next]
      if (!entry) return
      set({ providerID: entry.provider.id, modelID: entry.id })
    },
    set,
    visible(item) {
      return models.visible(item)
    },
    setVisibility(item, visible) {
      models.setVisibility(item, visible)
    },
    variant: {
      configured: () => undefined,
      selected: () => undefined,
      current: () => undefined,
      list: () => [],
      set() {},
      cycle() {},
    },
  }
}

const CurrentModelSummary: Component<{ model: ModelState; class?: string }> = (props) => {
  const language = useLanguage()
  const current = createMemo(() => props.model.current())

  return (
    <div
      class={`mx-1 mb-2 rounded-lg border px-3 py-2.5 ${props.class ?? ""}`}
      style={{
        "background-color": "var(--apple-light-alpha-5)",
        "border-color": "var(--border-weak-base)",
      }}
    >
      <Show
        when={current()}
        fallback={<div class="text-13-regular text-text-subtle">{language.t("dialog.model.select.title")}</div>}
      >
        {(item) => (
          <div class="flex min-w-0 items-start gap-2.5">
            <ProviderIcon
              id={modelProviderIconID(item())}
              class="mt-0.5 size-6 shrink-0 icon-strong-base"
              aria-label={item().provider.name}
            />
            <div class="min-w-0 flex-1">
              <div class="truncate text-16-medium font-semibold text-text-strong">{item().name}</div>
              <div class="mt-0.5 truncate text-12-regular text-text-weak">{item().provider.name}</div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
  tooltip?: boolean
}> = (props) => {
  const owner = getOwner()
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const providers = useProviders()
  const providerOrder = createMemo(() => providers.order())

  const models = createMemo(() =>
    model
      .list()
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-viewport]]:flex-1 [&_[data-slot=list-viewport]]:min-h-0 ${props.class ?? ""}`}
      virtual={false}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        return compareProviderGroups(providerOrder(), aProvider, bProvider, popularProviders)
      }}
      itemWrapper={
        props.tooltip === false
          ? undefined
          : (item, node) =>
              runWithOwner(owner, () => (
                <Tooltip
                  class="w-full"
                  placement="right-start"
                  gutter={12}
                  value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
                >
                  {node}
                </Tooltip>
              ))
      }
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  style?: JSX.CSSProperties
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  debugName?: string
  onOpenChange?: (open: boolean) => void
}) {
  const model = props.model ?? useLocal().model
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: "escape" | "outside" | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const platform = usePlatform()
  let content: HTMLDivElement | undefined
  let seq = 0
  let measureAt = 0
  let measureCount = 0
  let resizeAt = 0
  let resizeCount = 0
  let resizeObserver: ResizeObserver | undefined
  let stageAt = 0

  const handleManage = () => {
    setStore("open", false)
    dialog.show(() => <DialogManageModels />)
  }

  const handleConnectProvider = () => {
    setStore("open", false)
    dialog.show(() => <DialogSelectProvider />)
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        const trace = dbg()
        const id = trace ? ++seq : seq
        if (trace && next && stageAt === 0) stageAt = performance.now()
        if (trace && !next) stageAt = 0
        if (next) setStore("dismiss", null)
        setStore("open", next)
        if (trace && next) {
          logStage("after-set-open", {
            seq: id,
            ms: since(stageAt),
            content: !!content,
          })
        }
        if (trace) {
          logModelOpen("open-change", {
            seq: id,
            open: next,
            dismiss: store.dismiss ?? "none",
            content: !!content,
          })
          logStage("open-change", {
            seq: id,
            ms: stageAt ? Math.round(performance.now() - stageAt) : 0,
            open: next,
            content: !!content,
          })
        }
        if (!next && resizeObserver) {
          resizeObserver.disconnect()
          resizeObserver = undefined
        }
        if (trace && next) {
          const list = model.list().filter((item) => (props.provider ? item.provider.id === props.provider : true))
          const visible = list.filter((item) =>
            model.visible({ modelID: item.id, providerID: item.provider.id }),
          )
          logModelOpen("toggle", {
            open: next,
            total: list.length,
            visible: visible.length,
            provider: props.provider ?? "all",
            current: model.current()?.id ?? "none",
          })
          logStage("after-list", {
            seq: id,
            ms: since(stageAt),
            total: list.length,
            visible: visible.length,
          })
          measureAt = performance.now()
          measureCount = 0
          logStage("raf-request", {
            seq: id,
            ms: since(stageAt),
          })
          queueMicrotask(() => {
            if (id !== seq) return
            logStage("microtask", {
              seq: id,
              ms: since(stageAt),
              content: !!content,
            })
          })
          setTimeout(() => {
            if (id !== seq) return
            logStage("timeout-0", {
              seq: id,
              ms: since(stageAt),
              content: !!content,
            })
          }, 0)
          requestAnimationFrame(() => {
            if (id !== seq) return
            const el = content
            const box = rect(el)
            measureCount += 1
            logModelOpen("frame-1", {
              seq: id,
              stageMs: stageAt ? Math.round(performance.now() - stageAt) : "none",
              measures: measureCount,
              ms: Math.round(performance.now() - measureAt),
              nodes: el ? el.querySelectorAll("*").length : "none",
              items: el ? el.querySelectorAll('[data-slot="list-item"], [data-slot="select-select-item"]').length : "none",
              groups: el ? el.querySelectorAll('[data-slot="list-group"], [data-slot="select-section"]').length : "none",
              width: box?.width ?? "none",
              height: box?.height ?? "none",
              top: box?.top ?? "none",
              left: box?.left ?? "none",
            })
            logStage("frame-1", {
              seq: id,
              ms: stageAt ? Math.round(performance.now() - stageAt) : "none",
              nodes: el ? el.querySelectorAll("*").length : "none",
              items: el ? el.querySelectorAll('[data-slot="list-item"], [data-slot="select-select-item"]').length : "none",
              width: box?.width ?? "none",
              height: box?.height ?? "none",
              top: box?.top ?? "none",
              left: box?.left ?? "none",
            })
            requestAnimationFrame(() => {
              if (id !== seq) return
              const nextEl = content
              const nextBox = rect(nextEl)
              measureCount += 1
              logModelOpen("frame-2", {
                seq: id,
                stageMs: stageAt ? Math.round(performance.now() - stageAt) : "none",
                measures: measureCount,
                ms: Math.round(performance.now() - measureAt),
                nodes: nextEl ? nextEl.querySelectorAll("*").length : "none",
                items: nextEl ? nextEl.querySelectorAll('[data-slot="list-item"], [data-slot="select-select-item"]').length : "none",
                groups: nextEl ? nextEl.querySelectorAll('[data-slot="list-group"], [data-slot="select-section"]').length : "none",
                width: nextBox?.width ?? "none",
                height: nextBox?.height ?? "none",
                top: nextBox?.top ?? "none",
                left: nextBox?.left ?? "none",
              })
              logStage("frame-2", {
                seq: id,
                ms: stageAt ? Math.round(performance.now() - stageAt) : "none",
                nodes: nextEl ? nextEl.querySelectorAll("*").length : "none",
                items: nextEl ? nextEl.querySelectorAll('[data-slot="list-item"], [data-slot="select-select-item"]').length : "none",
                width: nextBox?.width ?? "none",
                height: nextBox?.height ?? "none",
                top: nextBox?.top ?? "none",
                left: nextBox?.left ?? "none",
              })
              if (box && nextBox) {
                logModelOpen("jump", {
                  seq: id,
                  stageMs: stageAt ? Math.round(performance.now() - stageAt) : "none",
                  dWidth: nextBox.width - box.width,
                  dHeight: nextBox.height - box.height,
                  dTop: nextBox.top - box.top,
                  dLeft: nextBox.left - box.left,
                })
                logStage("jump", {
                  seq: id,
                  ms: stageAt ? Math.round(performance.now() - stageAt) : "none",
                  dWidth: nextBox.width - box.width,
                  dHeight: nextBox.height - box.height,
                  dTop: nextBox.top - box.top,
                  dLeft: nextBox.left - box.left,
                })
              }
            })
          })
          requestAnimationFrame(() => {
            if (id !== seq) return
            const el = content
            if (!el) return
            measureCount += 1
            logModelOpen("content", {
              seq: id,
              measures: measureCount,
              ms: Math.round(performance.now() - measureAt),
              nodes: el.querySelectorAll("*").length,
              items: el.querySelectorAll('[data-slot="list-item"], [data-slot="select-select-item"]').length,
              groups: el.querySelectorAll('[data-slot="list-group"], [data-slot="select-section"]').length,
              height: Math.round(el.getBoundingClientRect().height),
            })
          })
        }
        props.onOpenChange?.(next)
        if (trace && next) {
          logStage("after-parent", {
            seq: id,
            ms: since(stageAt),
            content: !!content,
          })
        }
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          ref={(el) => {
            resizeObserver?.disconnect()
            resizeObserver = undefined
            content = el
            if (!dbg()) return
            if (el) stageAt = performance.now()
            const box = rect(el)
            logModelOpen("mount", {
              seq,
              width: box?.width ?? "none",
              height: box?.height ?? "none",
              top: box?.top ?? "none",
              left: box?.left ?? "none",
            })
            logStage("content-mount", {
              seq,
              ms: stageAt ? Math.round(performance.now() - stageAt) : "none",
              mounted: !!el,
              width: box?.width ?? "none",
              height: box?.height ?? "none",
              top: box?.top ?? "none",
              left: box?.left ?? "none",
            })
            if (!el) return
            resizeAt = performance.now()
            resizeCount = 0
            resizeObserver = new ResizeObserver(() => {
              resizeCount += 1
              const now = performance.now()
              const ms = Math.round(now - resizeAt)
              if (ms > 1200 || resizeCount > 8) {
                resizeObserver?.disconnect()
                resizeObserver = undefined
                return
              }
              const next = rect(el)
              logModelOpen("resize", {
                seq,
                count: resizeCount,
                ms,
                width: next?.width ?? "none",
                height: next?.height ?? "none",
                top: next?.top ?? "none",
                left: next?.left ?? "none",
                nodes: el.querySelectorAll("*").length,
                items: el.querySelectorAll('[data-slot="list-item"], [data-slot="select-select-item"]').length,
              })
            })
            resizeObserver.observe(el)
          }}
          data-component="popover-content"
          class="w-[338px] h-[39rem] max-h-[calc(100vh-96px)] flex flex-col p-2 overflow-hidden"
          style={props.style}
          onEscapeKeyDown={(event) => {
            logModelOpen("close", {
              seq,
              reason: "escape",
            })
            setStore("dismiss", "escape")
            setStore("open", false)
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => {
            logModelOpen("close", {
              seq,
              reason: "outside-pointer",
            })
            setStore("dismiss", "outside")
            setStore("open", false)
          }}
          onFocusOutside={() => {
            logModelOpen("close", {
              seq,
              reason: "outside-focus",
            })
            setStore("dismiss", "outside")
            setStore("open", false)
          }}
          onCloseAutoFocus={(event) => {
            logModelOpen("close-autofocus", {
              seq,
              dismiss: store.dismiss ?? "none",
            })
            if (store.dismiss === "outside") event.preventDefault()
            setStore("dismiss", null)
          }}
          onOpenAutoFocus={(event) => {
            const box = rect(content)
            logModelOpen("open-autofocus", {
              seq,
              width: box?.width ?? "none",
              height: box?.height ?? "none",
              top: box?.top ?? "none",
              left: box?.left ?? "none",
            })
            logStage("open-autofocus", {
              seq,
              ms: stageAt ? Math.round(performance.now() - stageAt) : "none",
              width: box?.width ?? "none",
              height: box?.height ?? "none",
              top: box?.top ?? "none",
              left: box?.left ?? "none",
            })
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <CurrentModelSummary model={model} />
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => setStore("open", false)}
            class="p-1"
            tooltip={false}
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const model = props.model ?? useLocal().model

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      containerStyle={{ height: "min(calc(100vh - 16px), 712px)" }}
      action={
        <Button
          class="h-7 -my-1 text-14-medium"
          icon="plus-small"
          tabIndex={-1}
          onClick={() => dialog.show(() => <DialogSelectProvider />)}
        >
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <CurrentModelSummary model={model} class="mx-0" />
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button
        variant="ghost"
        class="ml-3 mt-5 mb-6 text-text-base self-start"
        onClick={() => dialog.show(() => <DialogManageModels />)}
      >
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
