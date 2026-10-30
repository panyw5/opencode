import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { captureRect, exportErrorName, heightScript, readyScript, scrollScript } from "./session-document-render"
import { pngSlices } from "./session-document-policy"

describe("session export render scheduling", () => {
  test("short document height excludes the minimum viewport height", () => {
    expect(
      runInNewContext(heightScript, {
        document: {
          body: { scrollHeight: 127, getBoundingClientRect: () => ({ height: 126.5 }) },
          documentElement: { scrollHeight: 4096 },
        },
      }),
    ).toBe(127)
  })

  test("final clamped scroll crops the remaining rows without duplication", () => {
    const slices = pngSlices(9000)
    expect(captureRect(slices[0], 0)).toEqual({ x: 0, y: 0, width: 1200, height: 4096 })
    expect(captureRect(slices[1], 4096)).toEqual({ x: 0, y: 0, width: 1200, height: 4096 })
    expect(captureRect(slices[2], 9000 - 4096)).toEqual({ x: 0, y: 3288, width: 1200, height: 808 })
    expect(captureRect(pngSlices(127)[0], 0).height).toBe(127)
    expect(() => captureRect(slices[1], 0)).toThrow()
    expect(captureRect({ y: 4096, height: 2086 }, 2085.8, 600)).toEqual({ x: 0, y: 2010, width: 600, height: 2086 })
  })

  test("scroll scheduling returns actual scroll after two frames", async () => {
    const window = {
      scrollY: 0,
      scrollTo: ({ top }: { top: number }) => {
        window.scrollY = Math.min(top, 4904)
      },
    }
    expect(
      await runInNewContext(scrollScript(8192), {
        window,
        requestAnimationFrame: (callback: () => void) => callback(),
      }),
    ).toBe(4904)
    expect(() => scrollScript(NaN)).toThrow()
  })

  test("font/image scheduling returns a serializable result even if an image fails", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await runInNewContext(readyScript, {
      document: {
        fonts: { ready: Promise.resolve({}) },
        images: [{ decode: () => Promise.reject(new Error("bad image")) }],
      },
      setTimeout: (callback: () => void, delay: number) => {
        timer = setTimeout(callback, delay)
      },
    })
    clearTimeout(timer)
    expect(result).toBe(true)
  })

  test("diagnostics never expose custom error names or content", () => {
    expect(exportErrorName(new TypeError("private path"))).toBe("TypeError")
    const error = new Error("private body")
    error.name = "private title"
    expect(exportErrorName(error)).toBe("Error")
    expect(exportErrorName("private body")).toBe("UnknownError")
  })
})
