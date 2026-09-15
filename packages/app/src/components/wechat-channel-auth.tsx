import { createEffect, on, onCleanup, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { qrSvgDataUrl } from "@/lib/feishu-app-registration"
import {
  isWechatLoginTerminal,
  WechatAuthGeneration,
  requireWechatAuthData,
  WechatAuthRequestError,
} from "@/lib/wechat-auth"

export const WechatChannelAuth: Component<{ channelName: string; botId?: string; scannerUserId?: string }> = (
  props,
) => {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const [state, setState] = createStore({
    attemptID: "",
    status: "idle",
    qr: "",
    expiresAt: 0,
    verification: "",
    error: "",
    busy: false,
    connection: "",
  })
  const lifecycle = new WechatAuthGeneration()
  let activeName = props.channelName
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const stop = () => {
    lifecycle.advance()
    if (timer) clearTimeout(timer)
    if (expiryTimer) clearTimeout(expiryTimer)
    timer = undefined
    expiryTimer = undefined
    controller?.abort()
    controller = undefined
  }
  const cancelRemote = (attemptID: string, channelName: string) => {
    if (attemptID) void sdk.client.im.wechat.login.cancel({ channelName, attemptID }).catch(() => {})
  }
  const cancel = () => {
    const attemptID = state.attemptID
    stop()
    cancelRemote(attemptID, activeName)
    setState({ attemptID: "", status: "cancelled", qr: "", busy: false })
  }
  const poll = async (stamp: number, channelName: string, attemptID: string, verifyCode?: string) => {
    if (stamp !== lifecycle.value) return
    if (Date.now() >= state.expiresAt) {
      cancel()
      setState("status", "expired")
      return
    }
    try {
      const result = await sdk.client.im.wechat.login.poll(
        { channelName, attemptID, verifyCode },
        { signal: controller?.signal, throwOnError: false },
      )
      if (stamp !== lifecycle.value) return
      const status = requireWechatAuthData(result.data, result.response.status).status
      setState("status", status)
      setState("error", "")
      if (isWechatLoginTerminal(status)) {
        if (expiryTimer) clearTimeout(expiryTimer)
        expiryTimer = undefined
        setState("qr", "")
        return
      }
      if (status !== "need_verifycode") timer = setTimeout(() => void poll(stamp, channelName, attemptID), 750)
    } catch (error) {
      if (stamp !== lifecycle.value) return
      setState("error", language.t("config.channels.wechat.networkError"))
      if (error instanceof WechatAuthRequestError && !error.retryable) {
        setState({ status: "error", qr: "" })
        if (expiryTimer) clearTimeout(expiryTimer)
        expiryTimer = undefined
        return
      }
      timer = setTimeout(() => void poll(stamp, channelName, attemptID), 2500)
    }
  }
  const start = async () => {
    const old = state.attemptID
    const channelName = props.channelName
    stop()
    cancelRemote(old, activeName)
    activeName = channelName
    const stamp = lifecycle.value
    controller = new AbortController()
    setState({ busy: true, status: "starting", error: "", qr: "", verification: "", attemptID: "" })
    try {
      const result = await sdk.client.im.wechat.login.start(
        { channelName },
        { signal: controller.signal, throwOnError: false },
      )
      if (stamp !== lifecycle.value) {
        if (result.data) cancelRemote(result.data.attemptID, channelName)
        return
      }
      const data = requireWechatAuthData(result.data, result.response.status)
      if (!data.attemptID || !data.qrContent || !Number.isFinite(Number(data.expiresAt)))
        throw new WechatAuthRequestError(false)
      const remaining = Number(data.expiresAt) - Date.now()
      if (remaining <= 0 || remaining > 10 * 60_000) throw new WechatAuthRequestError(false)
      setState({
        attemptID: data.attemptID,
        status: data.status,
        expiresAt: Number(data.expiresAt),
        qr: qrSvgDataUrl(data.qrContent, 220),
      })
      expiryTimer = setTimeout(() => {
        if (stamp !== lifecycle.value) return
        cancel()
        setState("status", "expired")
      }, remaining)
      void poll(stamp, channelName, data.attemptID)
    } catch {
      if (stamp === lifecycle.value)
        setState({ status: "error", error: language.t("config.channels.wechat.networkError") })
    } finally {
      if (stamp === lifecycle.value) setState("busy", false)
    }
  }
  const check = async () => {
    const stamp = lifecycle.value
    try {
      const result = await sdk.client.im.wechat.status({ channelName: props.channelName })
      if (stamp === lifecycle.value) setState("connection", result.data?.status ?? "unknown")
    } catch {
      if (stamp === lifecycle.value) setState("connection", "unknown")
    }
  }
  createEffect(
    on(
      () => props.channelName,
      (channelName) => {
        stop()
        cancelRemote(state.attemptID, activeName)
        activeName = channelName
        setState({ attemptID: "", status: "idle", qr: "", error: "", busy: false })
      },
    ),
  )
  onCleanup(() => {
    const attempt = state.attemptID
    stop()
    cancelRemote(attempt, activeName)
  })
  return (
    <div
      class="flex flex-col gap-3 rounded-[12px] border border-border-weak-base p-3"
      data-component="wechat-channel-auth"
    >
      <p class="text-12-regular text-text-weak">{language.t("config.channels.wechat.hint")}</p>
      <Show when={props.botId}>
        <div class="break-all text-12-regular text-text-base">
          {language.t("config.channels.wechat.account")}: {props.botId}
          <br />
          {props.scannerUserId}
        </div>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button size="small" onClick={() => void start()} disabled={state.busy}>
          {props.botId ? language.t("config.channels.wechat.rebind") : language.t("config.channels.wechat.bind")}
        </Button>
        <Button size="small" variant="ghost" onClick={() => void check()}>
          {language.t("config.channels.wechat.check")}
        </Button>
        <Show when={state.attemptID && state.qr}>
          <Button size="small" variant="ghost" onClick={cancel}>
            {language.t("common.cancel")}
          </Button>
        </Show>
      </div>
      <Show when={state.qr}>
        <img
          src={state.qr}
          alt={language.t("config.channels.wechat.qrAlt")}
          class="h-[220px] w-[220px] max-w-full self-start rounded-[10px] bg-white p-2"
        />
      </Show>
      <Show when={state.status !== "idle"}>
        <div class="text-12-regular text-text-base">
          {language.t("config.channels.wechat.status")}: {state.status}
        </div>
      </Show>
      <Show when={state.status === "need_verifycode"}>
        <TextField
          label={language.t("config.channels.wechat.verify")}
          value={state.verification}
          onChange={(value) => setState("verification", value ?? "")}
        />
        <Button
          size="small"
          disabled={state.busy || !state.verification.trim()}
          onClick={async () => {
            const stamp = lifecycle.value
            setState("busy", true)
            try {
              await poll(stamp, props.channelName, state.attemptID, state.verification.trim())
            } finally {
              if (stamp === lifecycle.value) setState("busy", false)
            }
          }}
        >
          {language.t("common.confirm")}
        </Button>
      </Show>
      <Show when={state.status === "binded_redirect"}>
        <p class="text-12-regular text-text-weak">{language.t("config.channels.wechat.alreadyBound")}</p>
      </Show>
      <Show when={state.connection}>
        <div class="text-12-regular text-text-weak">
          {language.t("config.channels.wechat.connection")}: {state.connection}
        </div>
      </Show>
      <Show when={state.error}>
        <div class="text-12-regular text-text-danger">{state.error}</div>
      </Show>
    </div>
  )
}
