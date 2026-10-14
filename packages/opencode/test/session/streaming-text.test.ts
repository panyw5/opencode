import { afterEach, describe, expect, test } from "bun:test"
import { appendStreamingText, clearStreamingText, streamingText, withStreamingText } from "@/session/streaming-text"

const key = { sessionID: "stream-test", messageID: "message", partID: "part" }
afterEach(() => clearStreamingText({ sessionID: key.sessionID }))

describe("streaming snapshot text", () => {
  test("overlays text without mutating the persisted part", () => {
    const part = { id: key.partID, sessionID: key.sessionID, messageID: key.messageID, type: "text", text: "First" }
    expect(appendStreamingText(key, part.text, " paragraph")).toBe(5)
    expect(appendStreamingText(key, part.text, "\n\nSecond")).toBe(15)
    expect(withStreamingText(part).text).toBe("First paragraph\n\nSecond")
    expect(part.text).toBe("First")
  })

  test("uses UTF-16 offsets matching frontend string lengths", () => {
    expect(appendStreamingText(key, "", "\ud83d\ude00")).toBe(0)
    expect(appendStreamingText(key, "", "next")).toBe(2)
    expect(streamingText(key)).toBe("\ud83d\ude00next")
  })

  test("isolates ownership and clears removed message text", () => {
    appendStreamingText(key, "", "received")
    expect(streamingText({ ...key, sessionID: "other" })).toBeUndefined()
    clearStreamingText({ sessionID: "other", partID: key.partID })
    expect(streamingText(key)).toBe("received")
    clearStreamingText({ sessionID: key.sessionID, messageID: key.messageID })
    expect(streamingText(key)).toBeUndefined()
  })

  test("keeps tool parts untouched and clears final part snapshots", () => {
    appendStreamingText(key, "", "received")
    const tool = { id: key.partID, sessionID: key.sessionID, messageID: key.messageID, type: "tool" }
    expect(withStreamingText(tool)).toBe(tool)
    clearStreamingText({ sessionID: key.sessionID, partID: key.partID })
    expect(streamingText(key)).toBeUndefined()
  })
})
