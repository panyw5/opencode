import { expect, test } from "bun:test"
import { installWebViewport, webViewportGeometry } from "./web-viewport"

test("web viewport fits a phone keyboard without losing its visual offset", () => {
  expect(webViewportGeometry({ height: 448.5, offsetTop: 24.2, scale: 1, layoutHeight: 844 })).toEqual({
    height: 449,
    top: 24,
    keyboard: true,
  })
})

test("web viewport preserves tablet height and does not treat browser chrome as a keyboard", () => {
  expect(webViewportGeometry({ height: 980, offsetTop: -1, scale: 1, layoutHeight: 1024 })).toEqual({
    height: 980,
    top: 0,
    keyboard: false,
  })
})

test("web viewport does not interfere with pinch zoom or transient zero-height viewports", () => {
  expect(webViewportGeometry({ height: 400, offsetTop: 0, scale: 2, layoutHeight: 800 })).toBeUndefined()
  expect(webViewportGeometry({ height: 0, offsetTop: 0, scale: 1, layoutHeight: 800 })).toBeUndefined()
})

test("web viewport follows keyboard events, preserves zoom, and removes its listeners", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport")
  const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 })
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true })
  const html = document.documentElement
  const dispose = installWebViewport()
  try {
    expect(html.dataset.webLayout).toBe("true")
    viewport.height = 320
    viewport.offsetTop = 24
    viewport.dispatchEvent(new Event("resize"))
    expect(html.style.getPropertyValue("--app-viewport-height")).toBe("320px")
    await new Promise(requestAnimationFrame)
    expect(html.style.getPropertyValue("--app-viewport-height")).toBe("320px")
    expect(html.style.getPropertyValue("--app-viewport-top")).toBe("24px")
    expect(html.dataset.keyboardOpen).toBe("true")

    viewport.scale = 2
    viewport.height = 160
    viewport.dispatchEvent(new Event("resize"))
    await new Promise(requestAnimationFrame)
    expect(html.style.getPropertyValue("--app-viewport-height")).toBe("320px")

    dispose()
    viewport.scale = 1
    viewport.dispatchEvent(new Event("scroll"))
    await new Promise(requestAnimationFrame)
    expect(html.dataset.webLayout).toBeUndefined()
    expect(html.style.getPropertyValue("--app-viewport-height")).toBe("")
  } finally {
    dispose()
    if (original) Object.defineProperty(window, "visualViewport", original)
    else Reflect.deleteProperty(window, "visualViewport")
  }
})
