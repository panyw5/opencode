export const WINDOWS_TIMELINE_ROW_CACHE_MAX = 4_000
export const WINDOWS_TIMELINE_OVERSCAN = 12
export const DEFAULT_TIMELINE_OVERSCAN = 20

export function isWindowsElectron(userAgent: string) {
  return userAgent.includes("Windows") && userAgent.includes("Electron")
}

export function timelineOverscan(userAgent: string) {
  return isWindowsElectron(userAgent) ? WINDOWS_TIMELINE_OVERSCAN : DEFAULT_TIMELINE_OVERSCAN
}
