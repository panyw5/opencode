import { createMemo, For, Show } from "solid-js"
import { prettyLines, type Pretty } from "./pretty"

// Stretched-delimiter outlines in a 10x100 box. The svg is scaled to the row's
// height and non-scaling-stroke keeps the line at text weight, the way
// Mathematica draws tall brackets instead of blowing up the glyph.
const DELIM: Record<string, string> = {
  "(": "M7.6 2C4.9 13 3.4 30 3.4 50S4.9 87 7.6 98",
  ")": "M2.4 2C5.1 13 6.6 30 6.6 50S5.1 87 2.4 98",
  "[": "M7 3H3.4V97H7",
  "]": "M3 3H6.6V97H3",
  "[[": "M8.6 3H6.4V97H8.6 M4.4 3H2.2V97H4.4",
  "]]": "M1.4 3H3.6V97H1.4 M5.6 3H7.8V97H5.6",
  "{": "M7.4 2C5.2 2 4.4 4.5 4.4 9V40C4.4 45.5 2.2 46.5 2.2 50C2.2 53.5 4.4 54.5 4.4 60V91C4.4 95.5 5.2 98 7.4 98",
  "}": "M2.6 2C4.8 2 5.6 4.5 5.6 9V40C5.6 45.5 7.8 46.5 7.8 50C7.8 53.5 5.6 54.5 5.6 60V91C5.6 95.5 4.8 98 2.6 98",
  "\u003c|": "M5.6 4L2.2 50L5.6 96 M8 4V96",
  "|>": "M4.4 4L7.8 50L4.4 96 M2 4V96",
}

// The check part of the radical in a 14x100 box; the overline comes from the
// radicand's own border-top so it always sits above the content.
const RADSIGN = "M1 52L4.6 52L7 94L11 1.5L13.8 1.5"

function Delim(props: { text: string }) {
  const d = () => DELIM[props.text]
  return (
    <Show when={d()} fallback={<span data-token="punctuation">{props.text}</span>}>
      <svg class="oc-nb-d" data-d={props.text} viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true">
        <path d={d()} fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
    </Show>
  )
}

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
          <svg class="oc-nb-radsign" viewBox="0 0 14 100" preserveAspectRatio="none" aria-hidden="true">
            <path d={RADSIGN} fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" vector-effect="non-scaling-stroke" />
          </svg>
          <span class="oc-nb-rad">
            <Items items={props.node.arg} />
          </span>
        </span>
      )
    case "group":
      // Flat groups keep their source glyphs so wrapping stays free; tall
      // groups become a flex row whose drawn delimiters stretch to content.
      if (!props.node.tall)
        return (
          <>
            <span data-token="punctuation">{props.node.open}</span>
            <Items items={props.node.inner} />
            {props.node.close ? <span data-token="punctuation">{props.node.close}</span> : null}
          </>
        )
      return (
        <span class="oc-nb-gt" data-o={props.node.open} data-c={props.node.close}>
          <Delim text={props.node.open} />
          <Items items={props.node.inner} />
          {props.node.close ? <Delim text={props.node.close} /> : null}
        </span>
      )
    default:
      return <span data-token={props.node.cls}>{props.node.text}</span>
  }
}

// Rendered display of a code cell. Purely visual: the textarea still owns
// editing, focus, selection and the raw source.
export function PrettyCode(props: { value: string }) {
  const lines = createMemo(() => prettyLines(props.value))
  return (
    <div class="oc-nb-pretty" aria-hidden="true">
      <For each={lines()}>
        {(line) => <div class="oc-nb-pl">{line.length ? <Items items={line} /> : "​"}</div>}
      </For>
    </div>
  )
}
