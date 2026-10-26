import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import {
  usePlatform,
  type ResourceUsage,
  type ResourceUsageTarget,
  type ResourceUsageTargetId,
} from "@/context/platform"

const REFRESH_INTERVAL = 5000

const TARGET_LABEL_KEYS: Record<ResourceUsageTargetId, string> = {
  "opencode-cache": "home.resourceUsage.target.opencode-cache",
  "opencode-logs": "home.resourceUsage.target.opencode-logs",
  "desktop-cache": "home.resourceUsage.target.desktop-cache",
  "desktop-logs": "home.resourceUsage.target.desktop-logs",
}

const TARGET_DESC_KEYS: Record<ResourceUsageTargetId, string> = {
  "opencode-cache": "home.resourceUsage.target.opencode-cache.desc",
  "opencode-logs": "home.resourceUsage.target.opencode-logs.desc",
  "desktop-cache": "home.resourceUsage.target.desktop-cache.desc",
  "desktop-logs": "home.resourceUsage.target.desktop-logs.desc",
}

const RESOURCE_TARGETS: ResourceUsageTarget[] = (Object.keys(TARGET_LABEL_KEYS) as ResourceUsageTargetId[]).map(
  (id) => ({
    id,
    path: "",
    bytes: 0,
  }),
)

function ValueLoading() {
  return (
    <span class="home-resource-loading" aria-hidden="true">
      <span class="invisible">00.0 GB</span>
      <Spinner />
    </span>
  )
}

function InfoMark(props: { title: string }) {
  return (
    <Tooltip placement="top" openDelay={0} value={<span class="block max-w-72 text-11-regular">{props.title}</span>}>
      <span class="flex size-4 shrink-0 items-center justify-center rounded-full text-icon-weak transition-colors hover:text-icon-base">
        <svg viewBox="0 0 16 16" fill="none" class="size-3.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.2" />
          <path d="M8 7.4V11.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          <circle cx="8" cy="5" r="0.9" fill="currentColor" />
        </svg>
      </span>
    </Tooltip>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = "B"
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

function formatPercent(percent: number) {
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`
}

export default function HomeResourceUsage() {
  const platform = usePlatform()
  const language = useLanguage()
  const [cleaningId, setCleaningId] = createSignal<ResourceUsageTargetId | null>(null)
  const [usage, setUsage] = createSignal<ResourceUsage | null>(null)

  // Signal-based polling: a createResource here would suspend the router-level
  // Suspense boundary on every refetch and remount the whole home route.
  async function refresh() {
    if (!platform.resourceUsage) return
    const initial = !usage()
    const started = performance.now()
    if (initial) console.debug("[home-resource] initial-load-start")
    try {
      setUsage(await platform.resourceUsage())
      if (initial)
        console.debug(
          `[home-resource] initial-load-end duration=${(performance.now() - started).toFixed(1)}ms targets=${usage()?.targets.length ?? 0}`,
        )
    } catch (error) {
      console.error(
        `[home-resource] refresh-failed initial=${initial} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => {
      if (cleaningId()) return
      void refresh()
    }, REFRESH_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })

  async function clean(id: ResourceUsageTargetId) {
    if (!platform.cleanResourceTarget || cleaningId()) return
    console.debug(`[home-resource] clean-start target=${id}`)
    setCleaningId(id)
    try {
      const next = await platform.cleanResourceTarget(id)
      if (!next) {
        console.debug(`[home-resource] clean-cancelled target=${id}`)
        return
      }
      setUsage(next)
      console.debug(`[home-resource] clean-end target=${id}`)
      showToast({ variant: "success", title: language.t("home.resourceUsage.clean.done") })
    } catch (error) {
      console.error(
        `[home-resource] clean-failed target=${id} error=${error instanceof Error ? error.message : String(error)}`,
      )
      showToast({
        variant: "error",
        title: language.t("home.resourceUsage.clean.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setCleaningId(null)
    }
  }

  async function openFolder(target: ResourceUsageTarget) {
    if (!platform.openPath) return
    console.debug(`[home-resource] open-folder-start target=${target.id} path=${target.path}`)
    try {
      await platform.openPath(target.path)
      console.debug(`[home-resource] open-folder-end target=${target.id} path=${target.path}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[home-resource] open-folder-failed target=${target.id} path=${target.path} error=${message}`)
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
    }
  }

  return (
    <section class="home-section min-w-0" aria-labelledby="home-resource-usage" aria-busy={!usage()}>
      <div class="home-section-header flex min-h-8 items-center justify-between gap-3 pb-2">
        <h2 id="home-resource-usage" class="text-13-medium text-text-strong">
          {language.t("home.resourceUsage")}
        </h2>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="home-resource-metric flex min-w-0 flex-col gap-1">
          <div class="truncate text-11-regular text-text-weak">{language.t("home.resourceUsage.memory")}</div>
          <div class="home-resource-value truncate text-text-strong tabular-nums">
            <Show when={usage()} fallback={<ValueLoading />}>
              {(data) => formatBytes(data().memoryBytes)}
            </Show>
          </div>
        </div>
        <div class="home-resource-metric flex min-w-0 flex-col gap-1">
          <div class="truncate text-11-regular text-text-weak">{language.t("home.resourceUsage.cpu")}</div>
          <div class="home-resource-value truncate text-text-strong tabular-nums">
            <Show when={usage()} fallback={<ValueLoading />}>
              {(data) => formatPercent(data().cpuPercent)}
            </Show>
          </div>
        </div>
      </div>
      <ul class="home-resource-targets mt-3">
        <For each={RESOURCE_TARGETS}>
          {(target) => {
            const current = () => usage()?.targets.find((value) => value.id === target.id) ?? target
            return (
              <li class="home-resource-target" data-resource-id={target.id}>
                <span class="flex min-w-0 items-center gap-1">
                  <span class="truncate text-12-regular text-text-strong">
                    {language.t(TARGET_LABEL_KEYS[target.id])}
                  </span>
                  <InfoMark title={language.t(TARGET_DESC_KEYS[target.id])} />
                </span>
                <div class="home-resource-target-footer">
                  <span class="home-resource-target-value text-text-strong tabular-nums">
                    <Show when={usage()} fallback={<ValueLoading />}>
                      {formatBytes(current().bytes)}
                    </Show>
                  </span>
                  <div class="home-resource-target-actions">
                    <Tooltip value={current().path || language.t("config.action.openFolder")} placement="top">
                      <Button
                        size="small"
                        variant="ghost"
                        icon="folder"
                        class="shrink-0 px-2 text-text-weak"
                        aria-label={
                          current().path
                            ? `${language.t("config.action.openFolder")}: ${current().path}`
                            : language.t("config.action.openFolder")
                        }
                        disabled={!current().path || !platform.openPath}
                        onClick={() => void openFolder(current())}
                      />
                    </Tooltip>
                    <Button
                      size="small"
                      variant="ghost"
                      icon="trash"
                      class="shrink-0 px-2 text-11-regular text-text-weak"
                      disabled={cleaningId() !== null || current().bytes === 0}
                      onClick={() => void clean(target.id)}
                    >
                      {cleaningId() === target.id
                        ? language.t("home.resourceUsage.cleaning")
                        : language.t("home.resourceUsage.clean")}
                    </Button>
                  </div>
                </div>
              </li>
            )
          }}
        </For>
      </ul>
    </section>
  )
}
