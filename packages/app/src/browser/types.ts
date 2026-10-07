export type BrowserBounds = { x: number; y: number; width: number; height: number }
export type BrowserViewState = {
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
  bounds: BrowserBounds | null
}
export type BrowserDisplayState = {
  lease: number
  revision: number
  views: { partition: string; visible: boolean; bounds: BrowserBounds }[]
}
export type WindowBrowserApi = {
  getDisplayState: () => Promise<BrowserDisplayState>
  acquireDisplay: () => Promise<number>
  updateDisplay: (frame: BrowserDisplayFrame) => Promise<boolean>
  releaseDisplay: (lease: number) => Promise<void>
  getPresentation: () => Promise<BrowserPresentation | undefined>
  acknowledgePresentation: (id: number) => Promise<void>
  onPresented: (cb: (request: BrowserPresentation) => void) => () => void
  open: (partition: string, url: string) => Promise<BrowserViewState | undefined>
  setBounds: (partition: string, bounds: BrowserBounds | null) => Promise<void>
  setVisible: (partition: string, visible: boolean) => Promise<void>
  close: (partition: string) => Promise<void>
  navigate: (partition: string, action: "back" | "forward" | "reload") => Promise<void>
  setShared: (partition: string, shared: boolean) => Promise<void>
  getState: () => Promise<BrowserViewState[]>
  onUpdated: (cb: (state: BrowserViewState) => void) => () => void
  onClosed: (cb: (partition: string, epoch: number) => void) => () => void
}

export function browserApi(): WindowBrowserApi | undefined {
  return typeof window === "undefined" ? undefined : window.api?.browser
}
