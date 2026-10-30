import { Show, createUniqueId } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import type { ShareMessage } from "./session-share-model"

export function SessionShareMessage(props: {
  message: ShareMessage
  selected: boolean
  disabled: boolean
  roleLabel: string
  expandLabel: string
  collapseLabel: string
  onToggle: () => void
}) {
  const [state, setState] = createStore({ expanded: false })
  const detailsID = createUniqueId()
  const summary = () => props.message.markdown.replace(/\s+/g, " ").trim()
  const toggle = () => {
    if (props.disabled) return
    console.debug(`[session-share] selection toggle id=${props.message.id} selected=${!props.selected}`)
    props.onToggle()
  }
  return (
    <div class="session-share-message" data-selected={props.selected}>
      <div class="session-share-message-row">
        <div
          class="session-share-message-select"
          role="checkbox"
          aria-checked={props.selected}
          aria-label={`${props.roleLabel}: ${summary().slice(0, 160)}`}
          aria-disabled={props.disabled}
          tabIndex={props.disabled ? -1 : 0}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key !== " " && event.key !== "Enter") return
            event.preventDefault()
            toggle()
          }}
        >
          <span class="session-share-message-checkbox" aria-hidden="true" data-checked={props.selected}>
            <Show when={props.selected}>
              <Icon name="check-small" size="small" />
            </Show>
          </span>
          <span class="session-share-message-role" role="img" aria-label={props.roleLabel} title={props.roleLabel}>
            <Icon name={props.message.role === "user" ? "user" : "robot"} size="small" />
          </span>
          <span class="session-share-message-summary whitespace-normal text-text-weak">{summary()}</span>
        </div>
        <button
          type="button"
          class="session-share-message-expand"
          aria-expanded={state.expanded}
          aria-controls={detailsID}
          onClick={() => {
            console.debug(`[session-share] expansion toggle id=${props.message.id} expanded=${!state.expanded}`)
            setState("expanded", !state.expanded)
          }}
        >
          {state.expanded ? props.collapseLabel : props.expandLabel}
        </button>
      </div>
      <div
        id={detailsID}
        hidden={!state.expanded}
        class="session-share-message-details whitespace-pre-wrap break-words"
      >
        {props.message.markdown}
      </div>
    </div>
  )
}
