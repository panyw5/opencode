import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readArtifact, removeSessionArtifacts, snapshot } from "../../src/session/presentation"

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+JQ7nNwAAAABJRU5ErkJggg==", "base64"))
const jpeg = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Af//Z", "base64"))
let dirs: string[] = []
let sessions: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await Promise.all(sessions.map((sessionID) => removeSessionArtifacts(sessionID)))
  dirs = []
  sessions = []
})

describe("session presentation", () => {
  test("snapshots immutably and deduplicates identical bytes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "presentation-"))
    dirs.push(dir)
    const source = path.join(dir, "result.png")
    await writeFile(source, png)
    const sessionID = `test_${Date.now()}`
    sessions.push(sessionID)
    const first = await snapshot({ sessionID, sourcePath: source, purpose: "result" })
    expect(first.filename).toBe("result.png")
    expect(first.size).toBe(png.length)
    const duplicate = await snapshot({ sessionID, sourcePath: source, purpose: "result" })
    expect(duplicate.artifactID).toBe(first.artifactID)
    await writeFile(source, Uint8Array.from([1, 2, 3]))
    const original = await readArtifact({ sessionID, artifactID: first.artifactID, variant: "original" })
    expect(original?.body).toEqual(png)
  })

  test("rejects unsafe SVG and reports image MIME", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "presentation-"))
    dirs.push(dir)
    const safe = path.join(dir, "safe.png")
    await writeFile(safe, png)
    const sessionID = `test_${Date.now()}_mime`
    sessions.push(sessionID)
    const first = await snapshot({ sessionID, sourcePath: safe, purpose: "diagram" })
    expect(first.mime).toBe("image/png")
    expect((await readArtifact({ sessionID, artifactID: first.artifactID, variant: "thumbnail" }))?.body.length).toBeLessThanOrEqual(500 * 1024)
    const jpegPath = path.join(dir, "photo.jpg")
    await writeFile(jpegPath, jpeg)
    const jpegArtifact = await snapshot({ sessionID, sourcePath: jpegPath, purpose: "result" })
    expect((await readArtifact({ sessionID, artifactID: jpegArtifact.artifactID, variant: "thumbnail" }))?.mime).toBe("image/jpeg")
    expect(jpegArtifact.width).toBeUndefined()
    const unsafe = path.join(dir, "unsafe.svg")
    await writeFile(unsafe, `<svg><image href="https://evil.invalid/a.png" /></svg>`)
    await expect(snapshot({ sessionID, sourcePath: unsafe, purpose: "diagram" })).rejects.toThrow("unsafe")
    const safeSvg = path.join(dir, "safe.svg")
    await writeFile(safeSvg, `  \n<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="dot" d="M0 0h1v1z"/></defs><use href="#dot"/></svg>`)
    const svg = await snapshot({ sessionID, sourcePath: safeSvg, purpose: "diagram" })
    expect(svg.mime).toBe("image/svg+xml")
    expect((await readArtifact({ sessionID, artifactID: svg.artifactID, variant: "thumbnail" }))?.mime).toBe("image/svg+xml")
    const invalid = path.join(dir, "invalid.svg")
    await writeFile(invalid, "not svg")
    await expect(snapshot({ sessionID, sourcePath: invalid, purpose: "diagram" })).rejects.toThrow("SVG")
  })
})
