export function webViewportGeometry(input: { height: number; offsetTop: number; scale: number; layoutHeight: number }) {
  // Pinch zoom must not resize the app's layout or fight browser panning.
  if (Math.abs(input.scale - 1) > 0.01 || input.height <= 0) return undefined
  return {
    height: Math.round(input.height),
    top: Math.max(0, Math.round(input.offsetTop)),
    keyboard: input.layoutHeight - input.height > 150,
  }
}

export function installWebViewport() {
  const html = document.documentElement
  html.dataset.webLayout = "true"
  const viewport = window.visualViewport
  let previous = ""
  const update = () => {
    const geometry = webViewportGeometry({
      height: viewport?.height ?? window.innerHeight,
      offsetTop: viewport?.offsetTop ?? 0,
      scale: viewport?.scale ?? 1,
      layoutHeight: window.innerHeight,
    })
    if (!geometry) return
    const next = `${geometry.height}:${geometry.top}:${geometry.keyboard}`
    if (next === previous) return
    previous = next
    html.style.setProperty("--app-viewport-height", `${geometry.height}px`)
    html.style.setProperty("--app-viewport-top", `${geometry.top}px`)
    html.dataset.keyboardOpen = String(geometry.keyboard)
    console.debug(`[web-viewport] height=${geometry.height} top=${geometry.top} keyboard=${geometry.keyboard}`)
  }
  // Viewport events still arrive while background webviews suspend animation frames.
  const schedule = update
  update()
  window.addEventListener("resize", schedule)
  viewport?.addEventListener("resize", schedule)
  viewport?.addEventListener("scroll", schedule)
  return () => {
    window.removeEventListener("resize", schedule)
    viewport?.removeEventListener("resize", schedule)
    viewport?.removeEventListener("scroll", schedule)
    delete html.dataset.webLayout
    delete html.dataset.keyboardOpen
    html.style.removeProperty("--app-viewport-height")
    html.style.removeProperty("--app-viewport-top")
  }
}
