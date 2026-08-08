import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { resolveTestProtocol, testEndpointUrl, testProviderModel } from "./test-provider-model"

type Props = {
  baseURL: string
  apiKey: string
  modelId: string
  /** Custom provider npm (e.g. `@ai-sdk/anthropic`) — selects probe protocol. */
  npm?: string
  headers?: Array<{ key: string; value: string }>
  class?: string
}

type Phase = "idle" | "testing" | "success"

function formatSeconds(ms: number): string {
  const sec = Math.max(0, ms) / 1000
  // Keep one decimal so sub-second probes are readable (e.g. 0.3s).
  return `${sec.toFixed(1)}s`
}

export function TestProviderModelButton(props: Props) {
  const language = useLanguage()
  const platform = usePlatform()
  const [phase, setPhase] = createSignal<Phase>("idle")
  const [elapsedMs, setElapsedMs] = createSignal(0)
  const [resultMs, setResultMs] = createSignal(0)
  const [probeUrl, setProbeUrl] = createSignal("")

  let timer: ReturnType<typeof setInterval> | undefined
  let startedAt = 0
  let runId = 0
  let abort: AbortController | undefined

  const stopTimer = () => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const startTimer = () => {
    stopTimer()
    startedAt = Date.now()
    setElapsedMs(0)
    timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 100)
  }

  const clearAbort = () => {
    abort = undefined
  }

  const resetVisual = () => {
    stopTimer()
    setPhase("idle")
    setElapsedMs(0)
    setResultMs(0)
  }

  const cancelTest = () => {
    if (phase() !== "testing") return
    runId += 1
    abort?.abort()
    clearAbort()
    stopTimer()
    setPhase("idle")
    setElapsedMs(0)
    setResultMs(0)
  }

  onCleanup(() => {
    runId += 1
    abort?.abort()
    clearAbort()
    stopTimer()
  })

  // Clear success / cancel in-flight probe when inputs change.
  createEffect(() => {
    props.baseURL
    props.apiKey
    props.modelId
    props.npm
    for (const header of props.headers ?? []) {
      header.key
      header.value
    }
    runId += 1
    abort?.abort()
    clearAbort()
    setProbeUrl("")
    resetVisual()
  })

  const canStart = () => !!props.baseURL.trim() && !!props.modelId.trim()
  const isTesting = () => phase() === "testing"
  const showPathTooltip = () => !!probeUrl()
  const forcePathTooltip = () => isTesting() && !!probeUrl()

  const runTest = async () => {
    if (isTesting()) {
      cancelTest()
      return
    }
    if (!canStart()) return

    const key = props.apiKey.trim()
    if (key && /^\{env:[^}]+\}$/i.test(key)) {
      showToast({
        variant: "error",
        title: language.t("config.custom.models.test.failed"),
        description: language.t("config.custom.models.test.envKey"),
      })
      return
    }

    const protocol = resolveTestProtocol(props.npm)
    const url = testEndpointUrl(props.baseURL, protocol)
    setProbeUrl(url)

    const id = (runId += 1)
    abort?.abort()
    abort = new AbortController()
    const signal = abort.signal

    setPhase("testing")
    setResultMs(0)
    startTimer()

    try {
      const result = await testProviderModel({
        baseURL: props.baseURL,
        apiKey: props.apiKey,
        modelId: props.modelId,
        npm: props.npm,
        headers: props.headers,
        fetchImpl: platform.fetchExternal ?? fetch,
        signal,
      })

      if (id !== runId) return

      clearAbort()
      stopTimer()
      const latency = result.latencyMs
      setElapsedMs(latency)
      setResultMs(latency)

      if (result.ok) {
        setPhase("success")
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("config.custom.models.test.success"),
          description: language.t("config.custom.models.test.successDetail", {
            status: String(result.status),
            ms: String(result.latencyMs),
          }),
        })
        return
      }

      // User cancel already reset UI via cancelTest; treat as silent.
      if (result.cancelled) {
        setPhase("idle")
        setElapsedMs(0)
        setResultMs(0)
        return
      }

      setPhase("idle")
      const detail = [result.error, result.preview].filter(Boolean).join(" · ")
      showToast({
        variant: "error",
        title: language.t("config.custom.models.test.failed"),
        description: detail || language.t("common.requestFailed"),
      })
    } catch (e) {
      if (id !== runId) return
      clearAbort()
      stopTimer()
      setPhase("idle")
      showToast({
        variant: "error",
        title: language.t("config.custom.models.test.failed"),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const onClick = () => {
    if (isTesting()) {
      cancelTest()
      return
    }
    void runTest()
  }

  // Outer shell always owns row alignment (h-8 matches TextField input height).
  // Tooltip's `inactive` branch drops wrapper classes, so layout must live outside it.
  return (
    <div class={props.class ?? "flex h-8 w-full items-center justify-center"}>
      <Tooltip
        placement="top"
        gutter={6}
        openDelay={0}
        forceOpen={forcePathTooltip()}
        inactive={!showPathTooltip()}
        class="flex h-full w-full items-center justify-center"
        contentClass="!max-w-[min(360px,80vw)]"
        value={
          <div class="flex max-w-[min(360px,80vw)] flex-col gap-0.5 py-0.5">
            <span class="text-[10px] font-medium uppercase tracking-wide text-text-weak">
              {language.t("config.custom.models.test.path")}
            </span>
            <span class="break-all font-mono text-[11px] leading-snug text-text-strong">{probeUrl()}</span>
            <Show when={isTesting()}>
              <span class="text-[10px] text-text-weak">{language.t("config.custom.models.test.cancelHint")}</span>
            </Show>
          </div>
        }
      >
        <Button
          type="button"
          size="small"
          variant="ghost"
          class="w-full justify-center leading-none"
          classList={{
            "text-text-weak": phase() !== "success",
            "text-text-success-base": phase() === "success",
            "cursor-pointer": isTesting(),
          }}
          onClick={onClick}
          disabled={!isTesting() && !canStart()}
          aria-label={
            isTesting() ? language.t("config.custom.models.test.cancel") : language.t("config.custom.models.test")
          }
          title={isTesting() ? language.t("config.custom.models.test.cancel") : undefined}
          aria-live="polite"
        >
          <Show when={phase() === "success"}>
            <Icon name="circle-check" size="small" class="text-icon-success-base" />
          </Show>
          <Show when={isTesting()}>
            <span class="inline-flex items-center tabular-nums leading-none text-text-weak underline-offset-2 hover:underline">
              {formatSeconds(elapsedMs())}
            </span>
          </Show>
          <Show when={phase() === "success"}>
            <span class="inline-flex items-center tabular-nums leading-none text-text-success-base">
              {formatSeconds(resultMs())}
            </span>
          </Show>
          <Show when={phase() === "idle"}>
            <span class="inline-flex items-center leading-none text-text-weak">
              {language.t("config.custom.models.test")}
            </span>
          </Show>
        </Button>
      </Tooltip>
    </div>
  )
}
