export type BrowserBounds = { x: number; y: number; width: number; height: number }
export type BrowserViewState = {
  /** Unique WebContents identity. Older clients may omit it; use partition then. */
  pageID?: string
  /** Electron session identity; `partition` remains the legacy page-routing alias. */
  profileID?: string
  owner?: { directory?: string; sessionID?: string }
  kind?: "user" | "agent" | "consultation" | "login"
  partition: string
  url: string
  title: string
  loading: boolean
  shared: boolean
  epoch: number
}
export type BrowserPresentation = { id: number; state: BrowserViewState }
export type BrowserDisplayFrame = {
  lease: number
  revision: number
  partition: string | null
  /** Preferred display target; legacy frames target `partition`. */
  pageID?: string | null
  /** Selected page protected from cleanup even while an overlay hides it. */
  protectedPageID?: string | null
  bounds: BrowserBounds | null
}
export type BrowserDisplayState = {
  lease: number
  revision: number
  protectedPageID?: string
  views: { pageID?: string; profileID?: string; partition: string; visible: boolean; bounds: BrowserBounds }[]
}
export type WindowBrowserApi = {
  capturePreview: (pageID: string) => Promise<string | undefined>
  getDisplayState: () => Promise<BrowserDisplayState>
  acquireDisplay: () => Promise<number>
  updateDisplay: (frame: BrowserDisplayFrame) => Promise<boolean>
  releaseDisplay: (lease: number) => Promise<void>
  getPresentation: () => Promise<BrowserPresentation | undefined>
  acknowledgePresentation: (id: number) => Promise<void>
  onPresented: (cb: (request: BrowserPresentation) => void) => () => void
  open: (pageID: string, url: string) => Promise<BrowserViewState | undefined>
  setBounds: (pageID: string, bounds: BrowserBounds | null) => Promise<void>
  setVisible: (pageID: string, visible: boolean) => Promise<void>
  close: (pageID: string) => Promise<void>
  navigate: (pageID: string, action: "back" | "forward" | "reload") => Promise<void>
  setShared: (pageID: string, shared: boolean) => Promise<void>
  getState: () => Promise<BrowserViewState[]>
  onUpdated: (cb: (state: BrowserViewState) => void) => () => void
  onClosed: (cb: (pageID: string, epoch: number, profileID?: string) => void) => () => void
}

export function browserApi(): WindowBrowserApi | undefined {
  return typeof window === "undefined" ? undefined : window.api?.browser
}
