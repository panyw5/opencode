import { createMemo, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import larkIcon from "../../../ui/src/assets/icons/channel/lark.png"
import qqIcon from "../../../ui/src/assets/icons/channel/qq.png"
import wechatIcon from "../../../ui/src/assets/icons/channel/wechat.png"

export function ChannelBrandIcon(props: { platform: string; size?: number; label?: string }) {
  const source = createMemo(() => {
    const src =
      props.platform === "feishu"
        ? larkIcon
        : props.platform === "qq"
          ? qqIcon
          : props.platform === "wechat"
            ? wechatIcon
            : undefined
    console.debug(`[channel-brand-icon] platform=${props.platform} image=${!!src}`)
    return src
  })

  return (
    <span
      data-component="channel-brand-icon"
      data-platform={props.platform}
      class="inline-flex shrink-0 items-center justify-center"
      style={{ width: `${props.size ?? 38}px`, height: `${props.size ?? 38}px` }}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      title={props.label}
    >
      <Show
        when={source()}
        fallback={<Icon name={props.platform === "discord" ? "discord" : "speech-bubble"} size="medium" />}
      >
        {(src) => <img src={src()} alt="" aria-hidden="true" class="size-full object-contain" />}
      </Show>
    </span>
  )
}
