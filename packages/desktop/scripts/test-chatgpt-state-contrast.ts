// ChatGPT dark state matrix verification. Mirrors test-question-contrast.ts:
// isolated iframe with the dev renderer's real stylesheets, CDP-forced pseudo
// states, canvas-composited backgrounds. Reports text >= 4.5, icon >= 3, and
// usability state steps (adjacent bg oklch dL >= 0.04, selected-hover distinct).
// --baseline     report only, never fail (for diffing CSS iterations)
// --screenshot /tmp/path.png  render the fixture states and save a PNG
import { strict as assert } from "node:assert"
import { writeFile } from "node:fs/promises"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { contrastRatio } from "../../ui/src/theme/contrast"
import { hexToOklch } from "../../ui/src/theme/color"
import { resolveThemeVariant } from "../../ui/src/theme/resolve"
import type { HexColor } from "../../ui/src/theme/types"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[chatgpt-state-contrast-test] ${message}`)
const baseline = Bun.argv.includes("--baseline")
const tokens = resolveThemeVariant(DEFAULT_THEMES.chatgpt.dark, true)

const FIXTURE = String.raw`
<div id="fixture-root" style="display:flex;gap:20px;padding:16px;align-items:flex-start;font-family:var(--font-family-sans)">
  <div style="display:flex;flex-direction:column;gap:10px;width:260px">
    <div data-testid="tab-inactive" data-component="session-tab" role="button" class="group relative flex cursor-pointer select-none items-center gap-1.5 rounded-[10px] pl-2 pr-1 h-7 min-w-28 text-13-medium session-tab-inactive text-text-weak hover:bg-surface-base-hover hover:text-text-base">
      <span data-testid="tab-inactive-text" class="min-w-0 flex-1 truncate">Session A</span>
      <span data-testid="tab-inactive-close" class="session-tab-close flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-icon-base hover:bg-surface-base-hover hover:text-text-strong"><span data-slot="icon-svg" style="width:10px;height:10px;display:block"></span></span>
    </div>
    <div data-testid="tab-active" data-component="session-tab" data-active="true" role="button" class="group relative flex cursor-pointer select-none items-center gap-1.5 rounded-[10px] pl-2 pr-1 h-7 min-w-28 text-13-medium bg-surface-interactive-weak-hover text-text-strong">
      <span data-testid="tab-active-text" class="min-w-0 flex-1 truncate">Session B</span>
    </div>
    <div data-testid="tab-subagent" data-component="session-tab" data-subagent="true" role="button" class="group relative flex cursor-pointer select-none items-center gap-1.5 rounded-[10px] pl-2 pr-1 h-7 min-w-28 text-13-medium session-tab-inactive text-text-weak hover:bg-surface-base-hover hover:text-text-base">
      <span data-testid="tab-subagent-text" class="min-w-0 flex-1 truncate">Subagent</span>
    </div>
    <button data-testid="button-primary" data-component="button" data-variant="primary"><span>Primary</span></button>
    <button data-testid="button-primary-disabled" data-component="button" data-variant="primary" disabled><span>Primary off</span></button>
    <button data-testid="button-secondary" data-component="button" data-variant="secondary"><span>Secondary</span></button>
    <button data-testid="button-ghost" data-component="button" data-variant="ghost"><span>Ghost</span></button>
    <button data-testid="button-ghost-selected" data-component="button" data-variant="ghost" data-selected="true"><span>Ghost sel</span></button>
    <button data-testid="ibtn-ghost" data-component="icon-button" data-variant="ghost"><span data-slot="icon-svg" style="width:12px;height:12px;display:block"></span></button>
    <div data-component="input" data-variant="normal">
      <div data-slot="input-wrapper"><input data-slot="input-input" data-testid="input-input" value="Input value" placeholder="Placeholder" /></div>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px;width:300px">
    <div data-component="tabs">
      <div data-slot="tabs-list">
        <div data-slot="tabs-trigger-wrapper" data-testid="tabs-default-normal"><div data-slot="tabs-trigger">Default</div></div>
        <div data-slot="tabs-trigger-wrapper" data-testid="tabs-default-selected"><div data-slot="tabs-trigger" data-selected="true">Selected</div></div>
      </div>
    </div>
    <div data-component="tabs" data-variant="pill" data-orientation="horizontal">
      <div data-slot="tabs-list">
        <div data-slot="tabs-trigger-wrapper" data-testid="tabs-pill-normal"><div data-slot="tabs-trigger">Pill</div></div>
        <div data-slot="tabs-trigger-wrapper" data-testid="tabs-pill-selected"><div data-slot="tabs-trigger" data-selected="true">Pill sel</div></div>
      </div>
    </div>
    <div data-component="tabs" data-variant="alt">
      <div data-slot="tabs-list">
        <div data-slot="tabs-trigger-wrapper" data-testid="tabs-alt-normal"><div data-slot="tabs-trigger">Alt</div></div>
        <div data-slot="tabs-trigger-wrapper" data-testid="tabs-alt-selected"><div data-slot="tabs-trigger" data-selected="true">Alt sel</div></div>
      </div>
    </div>
    <div id="session-side-panel">
      <div data-component="tabs" data-variant="normal" data-orientation="horizontal">
        <div data-slot="tabs-list">
          <div data-slot="tabs-trigger-wrapper" data-testid="tabs-side-normal"><div data-slot="tabs-trigger">Side</div></div>
          <div data-slot="tabs-trigger-wrapper" data-testid="tabs-side-selected"><div data-slot="tabs-trigger" data-selected="true">Side sel</div></div>
        </div>
      </div>
    </div>
    <div data-component="list">
      <div data-slot="list-viewport">
        <div data-slot="list-item" data-testid="list-item"><span>List item</span></div>
        <div data-slot="list-item" data-testid="list-item-selected" data-active="true"><span>List sel</span></div>
      </div>
    </div>
    <div data-component="session-prompt-dock"><div data-component="dock-prompt" data-kind="question"><div data-slot="question-body" data-dock-surface="shell"><div data-slot="question-options">
    <button data-slot="question-option" data-testid="qopt-normal"><span data-slot="question-option-main"><span data-slot="option-label">Question option</span><span data-slot="option-description">Description</span></span></button>
    <button data-slot="question-option" data-testid="qopt-picked" data-picked="true"><span data-slot="question-option-main"><span data-slot="option-label">Picked option</span><span data-slot="option-description">Description</span></span></button>
    </div></div></div></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px;width:280px">
    <div data-component="dropdown-menu-content">
      <div data-slot="dropdown-menu-item" data-testid="dd-item"><span data-slot="dropdown-menu-item-label">Dropdown item</span></div>
      <div data-slot="dropdown-menu-item" data-testid="dd-item-disabled" data-disabled="true"><span data-slot="dropdown-menu-item-label">Dropdown off</span></div>
    </div>
    <div data-component="context-menu-content">
      <div data-slot="context-menu-item" data-testid="ctx-item"><span data-slot="context-menu-item-label">Context item</span></div>
      <div data-slot="context-menu-item" data-testid="ctx-item-disabled" data-disabled="true"><span data-slot="context-menu-item-label">Context off</span></div>
    </div>
    <div data-component="select">
      <button data-testid="select-trigger" data-component="button" data-variant="secondary" data-slot="select-select-trigger">Select trigger</button>
      <button data-testid="select-trigger-open" data-component="button" data-variant="secondary" data-slot="select-select-trigger" data-expanded="">Opened select</button>
    </div>
    <div data-component="select-content">
      <div data-slot="select-select-content-list">
        <div data-slot="select-select-item" data-testid="sel-item">Select option</div>
        <div data-slot="select-select-item" data-testid="sel-item-selected" data-selected="">Select selected</div>
        <div data-slot="select-select-item" data-testid="sel-item-disabled" data-disabled="true">Disabled</div>
      </div>
    </div>
    <label data-component="checkbox" data-testid="checkbox">
      <input data-slot="checkbox-checkbox-input" type="checkbox" />
      <span data-slot="checkbox-checkbox-control" data-testid="checkbox-control"><span data-slot="checkbox-checkbox-indicator"></span></span>
      <span data-slot="checkbox-checkbox-label" data-testid="checkbox-label">Checkbox</span>
    </label>
    <label data-component="checkbox" data-testid="checkbox-checked" data-checked="true">
      <input data-slot="checkbox-checkbox-input" type="checkbox" checked />
      <span data-slot="checkbox-checkbox-control" data-testid="checkbox-checked-control"><span data-slot="checkbox-checkbox-indicator"></span></span>
      <span data-slot="checkbox-checkbox-label" data-testid="checkbox-checked-label">Checked</span>
    </label>
    <div data-component="switch" data-testid="switch">
      <input data-slot="switch-input" type="checkbox" />
      <span data-slot="switch-control" data-testid="switch-control"><span data-slot="switch-thumb"></span></span>
      <span data-slot="switch-label" data-testid="switch-label">Switch</span>
    </div>
    <div data-component="switch" data-testid="switch-checked" data-checked="true">
      <input data-slot="switch-input" type="checkbox" checked />
      <span data-slot="switch-control" data-testid="switch-checked-control"><span data-slot="switch-thumb"></span></span>
      <span data-slot="switch-label" data-testid="switch-checked-label">Switch on</span>
    </div>
  </div>
</div>
`

// [id, selector, kind]; kind text needs 4.5, icon needs 3.
const SAMPLES = [
  ["tab-inactive", '[data-testid="tab-inactive-text"]', "text"],
  ["tab-inactive-close", '[data-testid="tab-inactive-close"]', "icon"],
  ["tab-active", '[data-testid="tab-active-text"]', "text"],
  ["tab-subagent", '[data-testid="tab-subagent-text"]', "text"],
  ["button-primary", '[data-testid="button-primary"] span', "text"],
  ["button-primary-disabled", '[data-testid="button-primary-disabled"] span', "text"],
  ["button-secondary", '[data-testid="button-secondary"] span', "text"],
  ["button-secondary-disabled", '[data-testid="button-secondary-disabled"] span', "text"],
  ["input-disabled", '[data-testid="input-disabled"]', "text"],
  ["checkbox-disabled", '[data-testid="checkbox-disabled-label"]', "text"],
  ["switch-disabled", '[data-testid="switch-disabled-label"]', "text"],
  ["button-ghost", '[data-testid="button-ghost"] span', "text"],
  ["button-ghost-selected", '[data-testid="button-ghost-selected"] span', "text"],
  ["ibtn-ghost", '[data-testid="ibtn-ghost"] [data-slot="icon-svg"]', "icon"],
  ["input", '[data-testid="input-input"]', "text"],
  ["input-placeholder", '[data-testid="input-input"]::placeholder', "text"],
  ["tabs-default", '[data-testid="tabs-default-normal"]', "text"],
  ["tabs-default-selected", '[data-testid="tabs-default-selected"]', "text"],
  ["tabs-pill", '[data-testid="tabs-pill-normal"]', "text"],
  ["tabs-pill-selected", '[data-testid="tabs-pill-selected"]', "text"],
  ["tabs-alt", '[data-testid="tabs-alt-normal"]', "text"],
  ["tabs-alt-selected", '[data-testid="tabs-alt-selected"]', "text"],
  ["tabs-side-panel", '[data-testid="tabs-side-normal"]', "text"],
  ["tabs-side-panel-selected", '[data-testid="tabs-side-selected"]', "text"],
  ["list-item", '[data-testid="list-item"]', "text"],
  ["list-item-selected", '[data-testid="list-item-selected"]', "text"],
  ["menu-dropdown", '[data-testid="dd-item"]', "text"],
  ["menu-dropdown-disabled", '[data-testid="dd-item-disabled"]', "text"],
  ["menu-context", '[data-testid="ctx-item"]', "text"],
  ["menu-context-disabled", '[data-testid="ctx-item-disabled"]', "text"],
  ["select-item", '[data-testid="sel-item"]', "text"],
  ["select-item-selected", '[data-testid="sel-item-selected"]', "text"],
  ["select-item-disabled", '[data-testid="sel-item-disabled"]', "text"],
  ["checkbox", '[data-testid="checkbox-label"]', "text"],
  ["checkbox-checked", '[data-testid="checkbox-checked-label"]', "text"],
  ["switch", '[data-testid="switch-label"]', "text"],
  ["switch-checked", '[data-testid="switch-checked-label"]', "text"],
  ["question-option", '[data-testid="qopt-normal"] [data-slot="option-label"]', "text"],
  ["question-option-desc", '[data-testid="qopt-normal"] [data-slot="option-description"]', "text"],
  ["question-option-picked", '[data-testid="qopt-picked"] [data-slot="option-label"]', "text"],
  ["select-trigger", '[data-testid="select-trigger"]', "text"],
  ["select-trigger-open", '[data-testid="select-trigger-open"]', "text"],
] as const

const LADDERS: { name: string; steps: [string, string][] }[] = [
  {
    name: "session-tab inactive normal->hover",
    steps: [
      ["tab-inactive", "normal"],
      ["tab-inactive", "hover"],
    ],
  },
  {
    name: "session-tab selected->selected-hover",
    steps: [
      ["tab-active", "selected"],
      ["tab-active", "selected-hover"],
    ],
  },
  {
    name: "session-tab subagent normal->hover",
    steps: [
      ["tab-subagent", "normal"],
      ["tab-subagent", "hover"],
    ],
  },
  {
    name: "tabs default normal->hover",
    steps: [
      ["tabs-default", "normal"],
      ["tabs-default", "hover"],
    ],
  },
  {
    name: "tabs default hover->active",
    steps: [
      ["tabs-default", "hover"],
      ["tabs-default", "active"],
    ],
  },
  {
    name: "tabs default selected->selected-hover",
    steps: [
      ["tabs-default-selected", "selected"],
      ["tabs-default-selected", "selected-hover"],
    ],
  },
  {
    name: "tabs pill selected->selected-hover",
    steps: [
      ["tabs-pill-selected", "selected"],
      ["tabs-pill-selected", "selected-hover"],
    ],
  },
  {
    name: "tabs alt selected->selected-hover",
    steps: [
      ["tabs-alt-selected", "selected"],
      ["tabs-alt-selected", "selected-hover"],
    ],
  },
  {
    name: "tabs side-panel selected->selected-hover",
    steps: [
      ["tabs-side-panel-selected", "selected"],
      ["tabs-side-panel-selected", "selected-hover"],
    ],
  },
  {
    name: "button primary normal->hover",
    steps: [
      ["button-primary", "normal"],
      ["button-primary", "hover"],
    ],
  },
  {
    name: "button primary hover->active",
    steps: [
      ["button-primary", "hover"],
      ["button-primary", "active"],
    ],
  },
  {
    name: "button secondary normal->hover",
    steps: [
      ["button-secondary", "normal"],
      ["button-secondary", "hover"],
    ],
  },
  {
    name: "button ghost normal->hover",
    steps: [
      ["button-ghost", "normal"],
      ["button-ghost", "hover"],
    ],
  },
  {
    name: "icon-button ghost normal->hover",
    steps: [
      ["ibtn-ghost", "normal"],
      ["ibtn-ghost", "hover"],
    ],
  },
  {
    name: "icon-button ghost hover->active",
    steps: [
      ["ibtn-ghost", "hover"],
      ["ibtn-ghost", "active"],
    ],
  },
  {
    name: "input normal->hover",
    steps: [
      ["input", "normal"],
      ["input", "hover"],
    ],
  },
  {
    name: "input hover->focus",
    steps: [
      ["input", "hover"],
      ["input", "focus"],
    ],
  },
  {
    name: "list item normal->hover",
    steps: [
      ["list-item", "normal"],
      ["list-item", "hover"],
    ],
  },
  {
    name: "list item selected->selected-hover",
    steps: [
      ["list-item-selected", "selected"],
      ["list-item-selected", "selected-hover"],
    ],
  },
  {
    name: "question option normal->hover",
    steps: [
      ["question-option", "normal"],
      ["question-option", "hover"],
    ],
  },
  {
    name: "question option picked->picked-hover",
    steps: [
      ["question-option-picked", "selected"],
      ["question-option-picked", "selected-hover"],
    ],
  },
  {
    name: "checkbox control normal->hover",
    steps: [
      ["checkbox-control", "normal"],
      ["checkbox-control", "hover"],
    ],
  },
  {
    name: "checkbox control checked->checked-hover",
    steps: [
      ["checkbox-checked-control", "selected"],
      ["checkbox-checked-control", "selected-hover"],
    ],
  },
  {
    name: "switch control normal->hover",
    steps: [
      ["switch-control", "normal"],
      ["switch-control", "hover"],
    ],
  },
  {
    name: "switch control checked->checked-hover",
    steps: [
      ["switch-checked-control", "selected"],
      ["switch-checked-control", "selected-hover"],
    ],
  },
]

const STATES = ["normal", "hover", "active", "selected", "selected-hover", "focus", "disabled"] as const
type State = (typeof STATES)[number]

const STATE_ROWS: Record<State, string[] | null> = {
  normal: null,
  hover: [
    "tab-inactive",
    "tab-inactive-close",
    "tab-subagent",
    "button-primary",
    "button-secondary",
    "button-ghost",
    "ibtn-ghost",
    "input",
    "tabs-default",
    "tabs-pill",
    "tabs-alt",
    "tabs-side-panel",
    "list-item",
    "menu-dropdown",
    "menu-context",
    "checkbox",
    "checkbox-checked",
    "switch",
    "switch-checked",
    "question-option",
  ],
  active: [
    "button-primary",
    "button-secondary",
    "button-ghost",
    "ibtn-ghost",
    "tabs-default",
    "list-item",
    "menu-dropdown",
    "menu-context",
  ],
  selected: [
    "tab-active",
    "tabs-default-selected",
    "tabs-pill-selected",
    "tabs-alt-selected",
    "tabs-side-panel-selected",
    "button-ghost-selected",
    "list-item-selected",
    "question-option-picked",
    "checkbox-checked-control",
    "switch-checked-control",
    "select-item-selected",
  ],
  "selected-hover": [
    "tab-active",
    "tabs-default-selected",
    "tabs-pill-selected",
    "tabs-alt-selected",
    "tabs-side-panel-selected",
    "button-ghost-selected",
    "list-item-selected",
    "question-option-picked",
    "checkbox-checked-control",
    "switch-checked-control",
  ],
  focus: ["input", "tabs-default", "button-secondary", "ibtn-ghost"],
  disabled: [
    "button-primary-disabled",
    "button-secondary-disabled",
    "input-disabled",
    "menu-dropdown-disabled",
    "menu-context-disabled",
    "select-item-disabled",
    "checkbox-disabled",
    "switch-disabled",
  ],
}

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  log(`chatgpt dark state matrix${baseline ? " (baseline, report only)" : ""}`)
  await cdp.call("DOM.enable")
  await cdp.call("CSS.enable")
  try {
    await cdp.evaluate(
      String.raw`((fixture, tokens) => {
        const frame = document.createElement('iframe');
        frame.id = 'chatgpt-state-contrast-test';
        frame.style.cssText = 'position:fixed;left:-4000px;top:0;width:1200px;height:900px';
        document.body.append(frame);
        const doc = frame.contentDocument;
        for (const sheet of document.styleSheets) {
          const style = doc.createElement('style');
          style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
          doc.head.append(style);
        }
        const style = doc.createElement('style');
        style.textContent = '* { transition: none !important; animation: none !important; }';
        doc.head.append(style);
        doc.body.innerHTML = fixture;
        const root = doc.documentElement;
        for (const [key, value] of Object.entries(tokens)) root.style.setProperty('--' + key, value);
        root.style.colorScheme = 'dark';
        root.style.backgroundColor = tokens['background-base'];
        root.dataset.theme = 'chatgpt';
        root.dataset.colorScheme = 'dark';
        // Disabled variants cloned from the enabled nodes; no business events fired.
        const cloneButton = (testid) => {
          const el = doc.querySelector('[data-testid="' + testid + '"]');
          const copy = el.cloneNode(true);
          copy.dataset.testid = testid + '-disabled';
          copy.disabled = true;
          el.parentElement.append(copy);
        };
        cloneButton('button-secondary');
        const input = doc.querySelector('[data-testid="input-input"]');
        const inputClone = input.cloneNode(true);
        inputClone.dataset.testid = 'input-disabled';
        inputClone.disabled = true;
        inputClone.removeAttribute('placeholder');
        // Own wrapper so the enabled wrapper's :not(:has(:disabled)) still matches.
        const inputHost = doc.createElement('div');
        inputHost.setAttribute('data-component', 'input');
        inputHost.setAttribute('data-variant', 'normal');
        const inputWrap = doc.createElement('div');
        inputWrap.setAttribute('data-slot', 'input-wrapper');
        inputWrap.append(inputClone);
        inputHost.append(inputWrap);
        doc.querySelector('[data-testid="input-input"]').closest('[data-component="input"]').parentElement.append(inputHost);
        for (const testid of ['checkbox', 'switch']) {
          const copy = doc.querySelector('[data-testid="' + testid + '"]').cloneNode(true);
          copy.dataset.testid = testid + '-disabled';
          copy.setAttribute('data-disabled', '');
          copy.querySelector('[data-slot$="-control"]').setAttribute('data-testid', testid + '-disabled-control');
          copy.querySelector('[data-slot$="-label"]').setAttribute('data-testid', testid + '-disabled-label');
          copy.querySelector('input').disabled = true;
          doc.querySelector('[data-testid="' + testid + '"]').parentElement.append(copy);
        }
        return true;
      })(${JSON.stringify(FIXTURE)}, ${JSON.stringify(tokens)})`,
    )
    await cdp.call("DOM.getDocument", { depth: -1, pierce: true })

    const pseudoTargets: Record<string, string> = {
      hover: [
        '[data-testid="tab-inactive"]',
        '[data-testid="tab-active"]',
        '[data-testid="tab-subagent"]',
        '[data-testid="tab-inactive-close"]',
        '[data-testid="button-primary"]',
        '[data-testid="button-secondary"]',
        '[data-testid="button-ghost"]',
        '[data-testid="ibtn-ghost"]',
        '[data-testid="input-input"]',
        '[data-slot="input-wrapper"]',
        '[data-testid="tabs-default-normal"]',
        '[data-testid="tabs-default-selected"]',
        '[data-testid="tabs-pill-normal"]',
        '[data-testid="tabs-pill-selected"]',
        '[data-testid="tabs-alt-normal"]',
        '[data-testid="tabs-alt-selected"]',
        '[data-testid="tabs-side-normal"]',
        '[data-testid="tabs-side-selected"]',
        '[data-testid="list-item"]',
        '[data-testid="list-item-selected"]',
        '[data-testid="dd-item"]',
        '[data-testid="ctx-item"]',
        '[data-testid="checkbox"]',
        '[data-testid="checkbox-checked"]',
        '[data-testid="switch"]',
        '[data-testid="switch-checked"]',
        '[data-testid="qopt-normal"]',
        '[data-testid="qopt-picked"]',
        '[data-testid="button-ghost-selected"]',
        '[data-testid="sel-item"]',
        '[data-testid="sel-item-selected"]',
        '[data-testid="select-trigger"]',
        '[data-testid="select-trigger-open"]',
        '[data-testid="button-primary-disabled"]',
        '[data-testid="button-secondary-disabled"]',
        '[data-testid="input-disabled"]',
        '[data-testid="dd-item-disabled"]',
        '[data-testid="ctx-item-disabled"]',
        '[data-testid="sel-item-disabled"]',
        '[data-testid="checkbox-disabled"]',
        '[data-testid="switch-disabled"]',
      ].join(","),
      active: [
        '[data-testid="button-primary"]',
        '[data-testid="button-secondary"]',
        '[data-testid="button-ghost"]',
        '[data-testid="ibtn-ghost"]',
        '[data-testid="tabs-default-normal"]',
        '[data-testid="list-item"]',
        '[data-testid="dd-item"]',
        '[data-testid="ctx-item"]',
        '[data-testid="tabs-pill-normal"]',
        '[data-testid="tabs-alt-normal"]',
        '[data-testid="tabs-side-normal"]',
      ].join(","),
      focus: [
        '[data-testid="input-input"]',
        '[data-testid="tabs-default-normal"] [data-slot="tabs-trigger"]',
        '[data-testid="button-primary"]',
        '[data-testid="button-secondary"]',
        '[data-testid="ibtn-ghost"]',
      ].join(","),
    }
    const nodeIds: Record<string, number[]> = {}
    for (const [pseudo, selector] of Object.entries(pseudoTargets)) {
      nodeIds[pseudo] = []
      const selectors = selector.split(",")
      for (let index = 0; index < selectors.length; index++) {
        const result = await cdp.call<{ result: { objectId: string } }>("Runtime.evaluate", {
          expression: `document.getElementById('chatgpt-state-contrast-test').contentDocument.querySelector('${selectors[index]}')`,
        })
        const node = await cdp.call<{ nodeId: number }>("DOM.requestNode", { objectId: result.result.objectId })
        nodeIds[pseudo].push(node.nodeId)
      }
    }

    const failures: string[] = []
    const infos: string[] = []
    let checked = 0
    const bgOf: Record<string, string> = {}
    const disabledSamples = SAMPLES.filter(([id]) => id.includes("disabled"))

    for (const state of STATES) {
      const pseudo =
        state === "hover" || state === "selected-hover"
          ? ["hover"]
          : state === "active"
            ? ["hover", "active"]
            : state === "focus"
              ? ["focus", "focus-visible"]
              : []
      for (const ids of Object.values(nodeIds)) {
        for (const nodeId of ids) {
          await cdp.call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: pseudo })
        }
      }
      const samples = await cdp.evaluate<{ id: string; fg: string | null; bg: string }[]>(
        String.raw`((rows, state, tokens) => {
        const doc = document.getElementById('chatgpt-state-contrast-test').contentDocument;
        const view = doc.defaultView;
        const canvas = doc.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', {willReadFrequently:true});
        const hex = () => '#' + [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('');
        const background = (el) => {
          const layers = [];
          for (let node = el; node; node = node.parentElement) layers.push(view.getComputedStyle(node).backgroundColor);
          ctx.clearRect(0,0,1,1);
          ctx.fillStyle = tokens['background-base'];
          ctx.fillRect(0,0,1,1);
          for (const color of layers.reverse()) { if (color && color !== 'transparent') { ctx.fillStyle = color; ctx.fillRect(0,0,1,1); } }
          return hex();
        };
        const out = [];
        for (const row of rows) {
          const [sel, pseudoName] = row[1].split('::');
          const el = doc.querySelector(sel);
          if (!el) continue;
          const style = view.getComputedStyle(el, pseudoName ? '::' + pseudoName : null);
          const bg = background(el);
          ctx.fillStyle = bg; ctx.fillRect(0,0,1,1);
          const opacity = Number(style.opacity);
          ctx.globalAlpha = opacity;
          ctx.fillStyle = style.color; ctx.fillRect(0,0,1,1);
          ctx.globalAlpha = 1;
          out.push({ id: row[0], fg: opacity === 0 ? null : hex(), bg });
        }
        for (const ctrl of ['checkbox-control','checkbox-checked-control','checkbox-disabled-control','switch-control','switch-checked-control','switch-disabled-control']) {
          const el = doc.querySelector('[data-testid="' + ctrl + '"]');
          if (el) out.push({ id: ctrl, fg: null, bg: background(el) });
        }
        return out;
      })(${JSON.stringify(
        SAMPLES.filter(
          (sample) =>
            state === "normal" || state === "hover" || state === "active" || STATE_ROWS[state]?.includes(sample[0]),
        ).map((sample) => [sample[0], sample[1]]),
      )}, ${JSON.stringify(state)}, ${JSON.stringify(tokens)})`,
      )
      for (const sample of samples) {
        bgOf[`${sample.id}@${state}`] = sample.bg
        if (!sample.fg) continue
        const spec = SAMPLES.find((item) => item[0] === sample.id)!
        const minimum = spec[2] === "icon" ? 3 : 4.5
        const ratio = contrastRatio(sample.fg as HexColor, sample.bg as HexColor)
        const l = hexToOklch(sample.bg as HexColor).l
        checked++
        const label = `${sample.id} ${state} ${spec[2]} ${ratio.toFixed(2)}:1 ${sample.fg}/${sample.bg} L=${l.toFixed(3)}`
        if (ratio < minimum) failures.push(`FAIL ${label} (min ${minimum})`)
        else log(label)
      }
    }

    // Usability distinctness: adjacent gray steps need dL >= 0.04; selected-hover must differ.
    for (const ladder of LADDERS) {
      const pair = ladder.steps.map(([id, state]) => bgOf[`${id}@${state}`])
      if (pair.some((bg) => !bg)) {
        failures.push(`FAIL ladder ${ladder.name}: missing sample`)
        continue
      }
      const [a, b] = pair
      const dL = Math.abs(hexToOklch(a as HexColor).l - hexToOklch(b as HexColor).l)
      const equal = a === b
      if (equal || dL < 0.04) {
        const message = `${a} -> ${b} dL=${dL.toFixed(3)} (need dL >= 0.04, distinct selected/hover)`
        failures.push(`FAIL ladder ${ladder.name}: ${message}`)
      } else log(`PASS ladder ${ladder.name}: dL=${dL.toFixed(3)}`)
    }

    // Disabled controls are exempt from WCAG contrast, but should stay legible and inert.
    for (const [id] of disabledSamples) {
      for (const state of ["hover", "active"]) {
        if (bgOf[`${id}@normal`] !== bgOf[`${id}@${state}`]) {
          failures.push(`FAIL ${id}: disabled background changed on ${state}`)
        }
      }
    }

    for (const info of infos) log(info)
    for (const failure of failures) log(failure)
    log(`${checked} samples checked, ${failures.length} failures, ${infos.length} observe/info notes`)
    if (baseline) log(`BASELINE mode: report only; ${failures.length} would-fail entries above`)
    else assert.equal(failures.length, 0, `${failures.length} chatgpt-dark state matrix violations`)
    log("note: state ratios describe this design-system check, not WCAG 3 conformance")

    const screenshotArg = Bun.argv[Bun.argv.indexOf("--screenshot") + 1]
    if (Bun.argv.includes("--screenshot") && screenshotArg) {
      await cdp.evaluate(String.raw`(() => {
        const frame = document.getElementById('chatgpt-state-contrast-test');
        frame.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:900px;z-index:2147483647;border:0';
        return true;
      })()`)
      const image = await cdp.call<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: 1200, height: 900, scale: 1 },
      })
      await writeFile(screenshotArg, Buffer.from(image.data, "base64"))
      log(`saved fixture screenshot to ${screenshotArg}`)
    }
  } finally {
    await cdp.evaluate("document.getElementById('chatgpt-state-contrast-test')?.remove()")
    await cdp.call("CSS.disable")
    await cdp.call("DOM.disable")
  }
})
