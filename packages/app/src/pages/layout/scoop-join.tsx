import type { JSX } from "solid-js"

/**
 * Chrome patch under a top-left border-radius so the concave join arcs into
 * rail/titlebar color instead of revealing canvas. Place absolutely behind
 * the rounded pane; size/color come from [data-component="scoop-join"] CSS.
 */
export function ScoopJoin(props: {
  class?: string
  style?: JSX.CSSProperties
}): JSX.Element {
  return (
    <div
      data-component="scoop-join"
      aria-hidden="true"
      class={`pointer-events-none absolute top-0 bg-background-base${props.class ? ` ${props.class}` : ""}`}
      style={props.style}
    />
  )
}
