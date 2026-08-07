import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { testProviderModel } from "./test-provider-model"

type Props = {
  baseURL: string
  apiKey: string
  modelId: string
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

  let timer: ReturnType<typeof setInterval> | undefined
  let startedAt = 0
  let runId = 0

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

  const resetVisual = () => {
    stopTimer()
    setPhase("idle")
    setElapsedMs(0)
    setResultMs(0)
  }

  onCleanup(() => {
    runId += 1
    stopTimer()
  })

  // Clear success / cancel in-flight probe when inputs change.
  createEffect(() => {
    props.baseURL
    props.apiKey
    props.modelId
    for (const header of props.headers ?? []) {
      header.key
      header.value
    }
    runId += 1
    resetVisual()
  })

  const canTest = () => !!props.baseURL.trim() && !!props.modelId.trim() && phase() !== "testing"

  const runTest = async () => {
    if (!canTest()) return

    const key = props.apiKey.trim()
    if (key && /^\{env:[^}]+\}$/i.test(key)) {
      showToast({
        variant: "error",
        title: language.t("config.custom.models.test.failed"),
        description: language.t("config.custom.models.test.envKey"),
      })
      return
    }

    const id = (runId += 1)
    setPhase("testing")
    setResultMs(0)
    startTimer()

    try {
      const result = await testProviderModel({
        baseURL: props.baseURL,
        apiKey: props.apiKey,
        modelId: props.modelId,
        headers: props.headers,
        fetchImpl: platform.fetchExternal ?? fetch,
      })

      if (id !== runId) return

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

      setPhase("idle")
      const detail = [result.error, result.preview].filter(Boolean).join(" · ")
      showToast({
        variant: "error",
        title: language.t("config.custom.models.test.failed"),
        description: detail || language.t("common.requestFailed"),
      })
    } catch (e) {
      if (id !== runId) return
      stopTimer()
      setPhase("idle")
      showToast({
        variant: "error",
        title: language.t("config.custom.models.test.failed"),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return (
    <Button
      type="button"
      size="small"
      variant="ghost"
      class={props.class}
      classList={{
        "text-text-weak": phase() !== "success",
        "text-text-success-base": phase() === "success",
      }}
      onClick={() => void runTest()}
      disabled={!canTest()}
      aria-label={language.t("config.custom.models.test")}
      aria-live="polite"
    >
      <Show when={phase() === "success"}>
        <Icon name="circle-check" size="small" class="text-icon-success-base" />
      </Show>
      <Show when={phase() === "testing"}>
        <span class="tabular-nums text-text-weak">{formatSeconds(elapsedMs())}</span>
      </Show>
      <Show when={phase() === "success"}>
        <span class="tabular-nums text-text-success-base">{formatSeconds(resultMs())}</span>
      </Show>
      <Show when={phase() === "idle"}>
        <span class="text-text-weak">{language.t("config.custom.models.test")}</span>
      </Show>
    </Button>
  )
}
