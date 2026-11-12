import { createMemo, For, onCleanup, onMount } from "solid-js"
import { prettyLines, type Pretty } from "./pretty"

function Items(props: { items: Pretty[] }) {
  return <For each={props.items}>{(node) => <Node node={node} />}</For>
}

function Node(props: { node: Pretty }) {
  switch (props.node.kind) {
    case "frac":
      return (
        <span class="oc-nb-frac">
          <span class="oc-nb-num">
            <Items items={props.node.num} />
          </span>
          <span class="oc-nb-den">
            <Items items={props.node.den} />
          </span>
        </span>
      )
    case "sup":
      return (
        <>
          <Items items={props.node.base} />
          <span class="oc-nb-exp">
            <Items items={props.node.exp} />
          </span>
        </>
      )
    case "sub":
      return (
        <>
          <Items items={props.node.base} />
          <span class="oc-nb-sub-i">
            <Items items={props.node.sub} />
          </span>
        </>
      )
    case "sqrt":
      return (
        <span class="oc-nb-sqrt">
          √<span class="oc-nb-rad">
            <Items items={props.node.arg} />
          </span>
        </span>
      )
    case "group":
      return (
        <span class="oc-nb-gr">
          <span class="oc-nb-d" data-token="punctuation">
            {props.node.open}
          </span>
          <Items items={props.node.inner} />
          {props.node.close ? (
            <span class="oc-nb-d" data-token="punctuation">
              {props.node.close}
            </span>
          ) : null}
        </span>
      )
    default:
      return <span data-token={props.node.cls}>{props.node.text}</span>
  }
}

// Enclosing delimiters track the height of what they wrap: each .oc-nb-d
// glyph is scaled to the union of its siblings' boxes (a taller fraction or
// radical inside a call gets matching brackets). One observer per rendered
// view refits every group whenever the block relayouts.
function fitGroups(root: HTMLElement) {
  for (const gr of root.querySelectorAll(".oc-nb-gr")) {
    let top = Infinity
    let bot = -Infinity
    // A nested group's own box is only a line tall — its fraction content
    // overflows it — so union every descendant, not just direct children.
    for (const c of gr.querySelectorAll("*")) {
      if (c.classList.contains("oc-nb-d")) continue
      const r = c.getBoundingClientRect()
      if (r.top < top) top = r.top
      if (r.bottom > bot) bot = r.bottom
    }
    const fs = parseFloat(getComputedStyle(gr).fontSize)
    if (!fs) continue
    const h = bot > top ? bot - top : fs
    // Glyphs like ( [ { stand ~1.15em tall, so the font is set a bit under the
    // measured content height; never shrink below the plain text size.
    const px = Math.min(fs * 4, Math.max(fs, h * 0.88))
    const size = `${Math.round(px * 10) / 10}px`
    for (const d of gr.children) {
      if (!d.classList.contains("oc-nb-d")) continue
      const el = d as HTMLElement
      if (el.style.fontSize !== size) el.style.fontSize = size
    }
  }
}

// Rendered display of a code cell. Purely visual: the textarea still owns
// editing, focus, selection and the raw source.
export function PrettyCode(props: { value: string }) {
  const lines = createMemo(() => prettyLines(props.value))
  let root!: HTMLDivElement
  onMount(() => {
    const fit = () => fitGroups(root)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(root)
    onCleanup(() => ro.disconnect())
  })
  return (
    <div class="oc-nb-pretty" aria-hidden="true" ref={root}>
      <For each={lines()}>
        {(line) => <div class="oc-nb-pl">{line.length ? <Items items={line} /> : "​"}</div>}
      </For>
    </div>
  )
}
