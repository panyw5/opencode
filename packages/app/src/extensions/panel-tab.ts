// Extension panel tabs live next to `file://` tabs in the session side panel.
// Tab value: `ext://<extensionID>/<panelID>`, with optional `?key=<value>` for
// multi-instance panels; any other query params seed the panel state.
import { isExtensionID } from "./id"

export const EXTENSION_TAB_PREFIX = "ext://"

const PANEL_ID = /^[a-z0-9._-]+$/
const KEY_PARAM = "key"

export type ExtensionPanelTab = {
  extensionID: string
  panelID: string
  key?: string
  state: Record<string, string>
}

export { isExtensionID }

export function isExtensionPanelTab(tab: string) {
  return tab.startsWith(EXTENSION_TAB_PREFIX)
}

export function parseExtensionPanelTab(tab: string): ExtensionPanelTab | undefined {
  if (!isExtensionPanelTab(tab)) return
  const rest = tab.slice(EXTENSION_TAB_PREFIX.length)
  const queryIndex = rest.indexOf("?")
  const target = queryIndex === -1 ? rest : rest.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : rest.slice(queryIndex + 1)

  const parts = target.split("/")
  if (parts.length !== 2) return
  const [extensionID, panelID] = parts
  if (!extensionID || !isExtensionID(extensionID)) return
  if (!panelID || !PANEL_ID.test(panelID)) return

  const state: Record<string, string> = {}
  let key: string | undefined
  for (const [name, value] of new URLSearchParams(query)) {
    if (name === KEY_PARAM) {
      if (value) key = value
      continue
    }
    state[name] = value
  }

  return key === undefined ? { extensionID, panelID, state } : { extensionID, panelID, key, state }
}

export function extensionPanelTab(input: {
  extensionID: string
  panelID: string
  key?: string
  state?: Record<string, string>
}) {
  if (!isExtensionID(input.extensionID)) throw new Error(`Invalid extension id: ${input.extensionID}`)
  if (!PANEL_ID.test(input.panelID)) throw new Error(`Invalid extension panel id: ${input.panelID}`)

  const params = new URLSearchParams()
  if (input.key) params.set(KEY_PARAM, input.key)
  for (const [name, value] of Object.entries(input.state ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (name === KEY_PARAM) continue
    params.set(name, value)
  }

  const query = params.toString()
  const base = `${EXTENSION_TAB_PREFIX}${input.extensionID}/${input.panelID}`
  return query ? `${base}?${query}` : base
}
