import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform, type ResourceUsage, type ResourceUsageTargetId } from "@/context/platform"

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
    try {
      setUsage(await platform.resourceUsage())
    } catch (error) {
      console.error("[home-resource] refresh failed", error)
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
    setCleaningId(id)
    try {
      const next = await platform.cleanResourceTarget(id)
      if (!next) return
      setUsage(next)
      showToast({ variant: "success", title: language.t("home.resourceUsage.clean.done") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("home.resourceUsage.clean.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setCleaningId(null)
    }
  }

  return (
    <section class="home-section min-w-0" aria-labelledby="home-resource-usage">
      <div class="home-section-header flex min-h-8 items-center justify-between gap-3 pb-2">
        <h2 id="home-resource-usage" class="text-13-medium text-text-strong">
          {language.t("home.resourceUsage")}
        </h2>
      </div>
      <Show
        when={usage()}
        fallback={
          <div class="flex min-h-28 items-center justify-center">
            <Spinner />
          </div>
        }
      >
        {(data) => (
          <>
            <div class="grid grid-cols-2 gap-1.5">
              <div class="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border-weaker-base bg-surface-base/60 px-2.5 py-2">
                <div class="truncate text-11-regular text-text-weak">{language.t("home.resourceUsage.memory")}</div>
                <div class="truncate text-13-medium text-text-strong tabular-nums">
                  {formatBytes(data().memoryBytes)}
                </div>
              </div>
              <div class="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border-weaker-base bg-surface-base/60 px-2.5 py-2">
                <div class="truncate text-11-regular text-text-weak">{language.t("home.resourceUsage.cpu")}</div>
                <div class="truncate text-13-medium text-text-strong tabular-nums">
                  {formatPercent(data().cpuPercent)}
                </div>
              </div>
            </div>
            <ul class="mt-2 flex flex-col gap-1">
              <For each={data().targets}>
                {(target) => (
                  <li class="flex items-center gap-3 rounded-lg border border-border-weaker-base bg-surface-base/60 px-2.5 py-1.5">
                    <span class="min-w-0 flex-1">
                      <span class="flex items-center gap-1">
                        <span class="truncate text-12-regular text-text-strong">
                          {language.t(TARGET_LABEL_KEYS[target.id])}
                        </span>
                        <InfoMark title={language.t(TARGET_DESC_KEYS[target.id])} />
                      </span>
                      <span class="mt-0.5 block truncate text-10-regular text-text-weaker" title={target.path}>
                        {target.path}
                      </span>
                    </span>
                    <span class="shrink-0 text-12-regular text-text-weak tabular-nums">
                      {formatBytes(target.bytes)}
                    </span>
                    <Button
                      size="small"
                      variant="ghost"
                      class="-mr-1 shrink-0 px-2 text-11-regular text-text-weak"
                      disabled={cleaningId() !== null || target.bytes === 0}
                      onClick={() => void clean(target.id)}
                    >
                      {cleaningId() === target.id
                        ? language.t("home.resourceUsage.cleaning")
                        : language.t("home.resourceUsage.clean")}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </section>
  )
}
