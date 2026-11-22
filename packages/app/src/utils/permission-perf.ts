type Entry = { step: string; t: number; detail?: string }

declare global {
  interface Window {
    __permPerf?: Entry[]
  }
}

export function permissionPerf(step: string, detail?: string) {
  const t = performance.now()
  const entries = (window.__permPerf ??= [])
  entries.push({ step, t, detail })
  if (entries.length > 500) entries.splice(0, entries.length - 500)
  console.debug(`[permission-perf] ${step} t=${t.toFixed(1)}${detail ? ` ${detail}` : ""}`)
}