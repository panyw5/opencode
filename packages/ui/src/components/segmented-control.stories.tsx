// @ts-nocheck
import { createSignal } from "solid-js"
import * as mod from "./segmented-control"
import { create } from "../storybook/scaffold"

const docs = `### Overview
Pill-shaped segmented control with a sliding selection indicator.

Use for switching between 2+ mutually exclusive options (status, document, transport).

### API
- \`options\`: \`{ value, label, trailing?, disabled? }[]\`.
- \`current\`: selected value; a value outside \`options\` hides the indicator.
- \`onSelect(value)\`: called when an option is clicked (or arrow-navigated in tablist mode).
- \`variant\`: \`"group"\` (default, aria-pressed buttons) or \`"tablist"\` (tab semantics + arrow keys).
- \`size\`: \`"small"\` (default) or \`"medium"\`. \`fill\` stretches to container width.
- \`optionDataKey\`: stamps \`data-{key}={value}\` on each option button.

### Variants and states
- Selected/hover/disabled states; hidden indicator when nothing selected.

### Accessibility
- \`group\`: \`role="group"\` + \`aria-pressed\`.
- \`tablist\`: \`role="tablist"\`/\`role="tab"\`, roving tabindex, Arrow/Home/End navigation.
- Always pass \`aria-label\`.

### Theming/tokens
- Uses \`data-component="segmented-control"\` and slot attributes.
`

const story = create({
  title: "UI/SegmentedControl",
  mod,
  args: {
    options: [
      { value: "open", label: "Open" },
      { value: "in_progress", label: "In progress" },
      { value: "done", label: "Done" },
    ],
    current: "in_progress",
    "aria-label": "Status",
  },
})

export default {
  title: "UI/SegmentedControl",
  id: "components-segmented-control",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic

export const States = {
  render: () => {
    const [value, setValue] = createSignal("in_progress")
    const [doc, setDoc] = createSignal("description")
    const options = [
      { value: "open", label: "Open" },
      { value: "in_progress", label: "In progress" },
      { value: "done", label: "Done" },
    ]
    return (
      <div style={{ display: "grid", gap: "16px", "justify-items": "start" }}>
        <mod.SegmentedControl aria-label="Status" options={options} current={value()} onSelect={setValue} />
        <mod.SegmentedControl
          aria-label="Document"
          options={[
            { value: "description", label: "Description" },
            { value: "progress", label: "progress.md" },
          ]}
          current={doc()}
          onSelect={setDoc}
        />
        <mod.SegmentedControl aria-label="Nothing selected" options={options} current="archived" />
        <mod.SegmentedControl aria-label="Disabled" options={options} current="open" disabled />
        <mod.SegmentedControl
          variant="tablist"
          id="demo"
          aria-label="Transport"
          size="medium"
          fill
          options={[
            { value: "cli", label: "CLI" },
            { value: "acp", label: "ACP" },
          ]}
          current="cli"
          style={{ "max-width": "460px" }}
        />
      </div>
    )
  },
}
