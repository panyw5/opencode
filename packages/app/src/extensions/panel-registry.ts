import { createSignal, type Accessor, type Component } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { parseExtensionPanelTab } from "./panel-tab"

export interface ExtensionPanelProps {
  state: Accessor<Record<string, string>>
  setState(patch: Record<string, string>): void
  close(): void
  directory: Accessor<string | undefined>
  sessionID: Accessor<string | undefined>
}

export type ExtensionPanelEntry = {
  extensionID: string
  id: string
  title: string | Accessor<string>
  // Host icon name, or an asset URL (anything containing ":" or "/").
  icon?: string
  component: Component<ExtensionPanelProps>
}

const panelKey = (extensionID: string, panelID: string) => `${extensionID}/${panelID}`

// Module-level so registrations survive session page remounts; entries are
// removed only through the disposer returned by registerExtensionPanel. A plain
// signal over an immutable Map keeps entries (and their components) unproxied.
const [panels, setPanels] = createSignal<ReadonlyMap<string, ExtensionPanelEntry>>(new Map())

export function registerExtensionPanel(entry: ExtensionPanelEntry) {
  const key = panelKey(entry.extensionID, entry.id)
  if (panels().has(key)) console.warn(`[extension-panel] replacing panel key=${key}`)
  setPanels((current) => new Map(current).set(key, entry))
  return () => {
    if (panels().get(key) !== entry) return
    setPanels((current) => {
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }
}

export function getExtensionPanel(extensionID: string, panelID: string): ExtensionPanelEntry | undefined {
  return panels().get(panelKey(extensionID, panelID))
}

export function extensionPanelTitle(entry: ExtensionPanelEntry) {
  return typeof entry.title === "function" ? entry.title() : entry.title
}

// Panel state is kept in memory, keyed by the full tab value and seeded from
// the tab's query params. Rewriting the tab value would change the tab
// identity (and remount the keyed panel), so persisting state is left to the
// extension host. Like the registry above it is module-level so it survives
// session page remounts; entries leave only through evictExtensionPanelTab
// (tab close) and evictExtensionPanelState (extension teardown), so closed
// tabs and removed extensions cannot leak state.
const [panelState, setPanelState] = createStore<Record<string, Record<string, string>>>({})

export function getExtensionPanelState(tab: string): Record<string, string> | undefined {
  return panelState[tab]
}

export function setExtensionPanelState(tab: string, next: Record<string, string>) {
  setPanelState(tab, next)
}

function dropExtensionPanelState(keys: string[]) {
  if (keys.length === 0) return
  setPanelState(
    produce((state) => {
      for (const key of keys) delete state[key]
    }),
  )
}

// Drops every stored entry whose tab belongs to the extension. Called when the
// extension is deactivated, disabled or uninstalled so its panels reopen with
// fresh, query-seeded state instead of data from a previous lifecycle.
export function evictExtensionPanelState(extensionID: string) {
  const keys = Object.keys(panelState).filter((tab) => parseExtensionPanelTab(tab)?.extensionID === extensionID)
  dropExtensionPanelState(keys)
  console.debug(`[extension-panel] panel state evicted id=${extensionID} count=${keys.length}`)
  return keys.length
}

// Drops the stored state of a single closed tab. Multi-instance panels use
// distinct tab values (`?key=`), so only the closed instance is evicted.
export function evictExtensionPanelTab(tab: string) {
  const hit = panelState[tab] !== undefined
  dropExtensionPanelState(hit ? [tab] : [])
  const id = parseExtensionPanelTab(tab)?.extensionID ?? "unknown"
  console.debug(`[extension-panel] panel state evicted id=${id} count=${hit ? 1 : 0}`)
  return hit ? 1 : 0
}
