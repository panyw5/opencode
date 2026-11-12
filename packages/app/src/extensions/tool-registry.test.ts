import { beforeAll, describe, expect, mock, test } from "bun:test"
import { extensionToolRendererNames } from "./id"

// `@opencode-ai/ui/message-part` transitively imports @solidjs/router and
// @kobalte/core, whose module scopes call client-only APIs that throw under
// bun:test. Follow the pattern in pages/session/timeline/rows.test.ts: stub
// those modules first, then import the registry lazily.
const KOBALTE_SUBPATHS = [
  "accordion",
  "button",
  "checkbox",
  "collapsible",
  "context-menu",
  "dialog",
  "dropdown-menu",
  "hover-card",
  "popover",
  "progress",
  "radio-group",
  "segmented-control",
  "select",
  "switch",
  "tabs",
  "text-field",
  "toast",
  "tooltip",
]
const KOBALTE_EXPORTS = [
  "Accordion",
  "Button",
  "Checkbox",
  "Collapsible",
  "ContextMenu",
  "Dialog",
  "DropdownMenu",
  "HoverCard",
  "Popover",
  "Progress",
  "RadioGroup",
  "SegmentedControl",
  "Select",
  "Switch",
  "Tabs",
  "TextField",
  "Toast",
  "Tooltip",
]
const kobalteStub = () => {
  const target: Record<string, unknown> = {}
  for (const name of KOBALTE_EXPORTS) target[name] = new Proxy({}, { get: () => () => undefined })
  target.toaster = new Proxy(() => undefined, { get: () => () => undefined })
  return new Proxy(target, {
    get: (obj, key) => Reflect.get(obj, key),
    ownKeys: () => Reflect.ownKeys(target),
  })
}

let registerTool: (typeof import("@opencode-ai/ui/message-part"))["registerTool"]
let getTool: (typeof import("@opencode-ai/ui/message-part"))["getTool"]

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    A: () => undefined,
    Navigate: () => undefined,
    Route: () => undefined,
    Router: () => undefined,
    useIsRouting: () => false,
    useLocation: () => ({ pathname: "/", search: "", hash: "", state: undefined, key: "" }),
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  for (const subpath of KOBALTE_SUBPATHS) mock.module(`@kobalte/core/${subpath}`, () => kobalteStub())
  const mod = await import("@opencode-ai/ui/message-part")
  registerTool = mod.registerTool
  getTool = mod.getTool
})

// D1: the host registers a tool renderer under the namespaced name plus the
// legacy unprefixed alias, so message parts resolve under either spelling.
describe("extension tool renderer names", () => {
  test("renderers resolve under both the prefixed and legacy names", () => {
    const names = extensionToolRendererNames("local.wls-repl", "wolfram_eval")
    const render = () => null
    const disposers = [
      registerTool({ name: names.primary, render }),
      ...(names.legacy ? [registerTool({ name: names.legacy, render })] : []),
    ]
    try {
      expect(getTool("wls_repl_wolfram_eval")).toBe(render)
      expect(getTool("wolfram_eval")).toBe(render)
    } finally {
      for (const dispose of disposers) dispose()
    }
    expect(getTool("wls_repl_wolfram_eval")).toBeUndefined()
    expect(getTool("wolfram_eval")).toBeUndefined()
  })
})
