import { describe, expect, test } from "bun:test"
import { formatPresentationSize, presentationRequestIsCurrent, readPresentationMetadata } from "./presentation-card"

describe("presentation metadata", () => {
  test("reads the nested tool metadata contract", () => {
    expect(readPresentationMetadata({ presentation: {
      artifactID: "artifact-1",
      mime: "image/png",
      filename: "screen.png",
      size: 2048,
      sourcePath: "/tmp/screen.png",
      purpose: "verification",
    } })).toMatchObject({ artifactID: "artifact-1", mime: "image/png", size: 2048, purpose: "verification" })
  })

  test("rejects malformed or unsafe media metadata", () => {
    expect(readPresentationMetadata({ presentation: { artifactID: "x", mime: "text/html" } })).toBeUndefined()
    expect(readPresentationMetadata({ presentation: { mime: "image/png" } })).toBeUndefined()
  })

  test("accepts the completed metadata shape after a pending part", () => {
    expect(readPresentationMetadata(undefined)).toBeUndefined()
    const legacy = readPresentationMetadata({ presentation: { artifactID: "x", mime: "image/svg+xml", filename: "x.svg", sourcePath: "x.svg", purpose: "result" } })
    expect(legacy?.artifactID).toBe("x")
    expect(legacy?.size).toBeUndefined()
  })

  test("formats original file sizes and ignores invalid values", () => {
    expect(formatPresentationSize(0, "en")).toBe("0 B")
    expect(formatPresentationSize(167, "en")).toBe("167 B")
    expect(formatPresentationSize(2900, "en")).toBe("2.8 KB")
    expect(formatPresentationSize(1024 * 1024, "en")).toBe("1 MB")
    expect(formatPresentationSize(undefined, "en")).toBeUndefined()
    expect(formatPresentationSize(-1, "en")).toBeUndefined()
  })

  test("rejects an aborted or stale async response", () => {
    expect(presentationRequestIsCurrent({ aborted: false, requestedArtifactID: "b", currentArtifactID: "a" })).toBe(false)
    expect(presentationRequestIsCurrent({ aborted: true, requestedArtifactID: "a", currentArtifactID: "a" })).toBe(false)
    expect(presentationRequestIsCurrent({ aborted: false, requestedArtifactID: "b", currentArtifactID: "b" })).toBe(true)
  })
})
