import { createMemo, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import larkIcon from "../../../ui/src/assets/icons/channel/lark.png"
import qqIcon from "../../../ui/src/assets/icons/channel/qq.png"
import wechatIcon from "../../../ui/src/assets/icons/channel/wechat.png"

export const CHANNEL_BRAND_IMAGES: Record<string, string> = {
  feishu: larkIcon,
  qq: qqIcon,
  wechat: wechatIcon,
}

const DISCORD_ICON_PATH =
  "M16.0742 4.45014C14.9244 3.92097 13.7106 3.54556 12.4638 3.3335C12.2932 3.64011 12.1388 3.95557 12.0013 4.27856C10.6732 4.07738 9.32261 4.07738 7.99451 4.27856C7.85694 3.9556 7.70257 3.64014 7.53203 3.3335C6.28441 3.54735 5.06981 3.92365 3.91889 4.45291C1.63401 7.85128 1.01462 11.1652 1.32431 14.4322C2.6624 15.426 4.16009 16.1819 5.7523 16.6668C6.11082 16.1821 6.42806 15.6678 6.70066 15.1295C6.18289 14.9351 5.68315 14.6953 5.20723 14.4128C5.33249 14.3215 5.45499 14.2274 5.57336 14.136C6.95819 14.7907 8.46965 15.1302 9.99997 15.1302C11.5303 15.1302 13.0418 14.7907 14.4266 14.136C14.5463 14.2343 14.6688 14.3284 14.7927 14.4128C14.3159 14.6957 13.8152 14.9361 13.2965 15.1309C13.5688 15.669 13.8861 16.1828 14.2449 16.6668C15.8385 16.1838 17.3373 15.4283 18.6756 14.4335C19.039 10.645 18.0549 7.36145 16.0742 4.45014ZM7.09294 12.423C6.22992 12.423 5.51693 11.6357 5.51693 10.6671C5.51693 9.69852 6.20514 8.90427 7.09019 8.90427C7.97524 8.90427 8.68272 9.69852 8.66758 10.6671C8.65244 11.6357 7.97248 12.423 7.09294 12.423ZM12.907 12.423C12.0426 12.423 11.3324 11.6357 11.3324 10.6671C11.3324 9.69852 12.0206 8.90427 12.907 8.90427C13.7934 8.90427 14.4954 9.69852 14.4803 10.6671C14.4651 11.6357 13.7865 12.423 12.907 12.423Z"

const SVG_NS = "http://www.w3.org/2000/svg"

/** Imperative icon element for contenteditable prompt pills, where Solid components cannot render. */
export function createChannelBrandIconElement(platform: string | undefined, size = "1.2em"): HTMLElement | SVGElement {
  const src = platform ? CHANNEL_BRAND_IMAGES[platform] : undefined
  if (src) {
    const img = document.createElement("img")
    img.src = src
    img.alt = ""
    img.setAttribute("aria-hidden", "true")
    img.style.width = size
    img.style.height = size
    img.style.flexShrink = "0"
    img.style.objectFit = "contain"
    return img
  }
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  const element = svg as SVGElement & { style: CSSStyleDeclaration }
  element.style.width = size
  element.style.height = size
  element.style.flexShrink = "0"
  const shape = document.createElementNS(SVG_NS, "path")
  if (platform === "discord") {
    svg.setAttribute("fill", "currentColor")
    shape.setAttribute("d", DISCORD_ICON_PATH)
  } else {
    svg.setAttribute("fill", "none")
    svg.setAttribute("stroke", "currentColor")
    svg.setAttribute("stroke-width", "1.5")
    shape.setAttribute("d", "M3 4.5h14v10H8l-5 2v-12z")
    shape.setAttribute("stroke-linejoin", "round")
  }
  svg.append(shape)
  return svg
}

export function ChannelBrandIcon(props: { platform: string; size?: number; label?: string }) {
  const source = createMemo(() => {
    const src = CHANNEL_BRAND_IMAGES[props.platform]
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
