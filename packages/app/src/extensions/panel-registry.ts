import { createSignal, type Accessor, type Component } from "solid-js"

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
