import { createMemo, For } from "solid-js"
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
      return <Items items={props.node.inner} />
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
