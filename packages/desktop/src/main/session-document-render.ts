// A private world keeps measurement globals separate from document script globals.
// Page scripts remain blocked by the document's script-src 'none' CSP.
export const exportWorld = 1001

export const readyScript = `Promise.race([Promise.all([document.fonts.ready,...Array.from(document.images, image => image.decode().catch(() => {}))]),new Promise((_, reject) => setTimeout(() => reject(new Error('Export render timeout')),15000))]).then(() => true)`

// Root scrollHeight is at least the viewport height, leaving short exports mostly blank.
export const heightScript = `Math.max(1, document.body.scrollHeight, Math.ceil(document.body.getBoundingClientRect().height))`

export function scrollScript(y: number) {
  if (!Number.isInteger(y) || y < 0 || y > 200_000) throw new Error("Invalid export scroll position")
  return `window.scrollTo({top:${y},left:0,behavior:'instant'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.scrollY))))`
}

export function captureRect(slice: { y: number; height: number }, scrollY: number, width = 1200) {
  const top = Math.max(0, Math.min(4096 - slice.height, Math.round(slice.y - scrollY)))
  if (Math.abs(top - (slice.y - scrollY)) > 1) throw new Error("Export scroll position outside capture viewport")
  if (!Number.isFinite(top) || top < 0 || top + slice.height > 4096)
    throw new Error("Export scroll position outside capture viewport")
  return { x: 0, y: Math.round(top), width, height: slice.height }
}

export function exportErrorName(error: unknown) {
  if (!(error instanceof Error)) return "UnknownError"
  const name = error.name
  return ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError"].includes(name) ? name : "Error"
}
