import { describe, expect, test } from "bun:test"
import { readSessionReference } from "./session-reference"

const reference = {
  type: "session" as const,
  sessionID: "ses_123",
  directory: "/repo",
  title: "Source",
  summary: "Context",
  updatedAt: 1700000000000,
}

describe("readSessionReference", () => {
  test("reads persisted reference metadata", () => {
    expect(readSessionReference({ sessionReference: reference })).toEqual(reference)
  })
  test("rejects incomplete metadata and unsafe route IDs", () => {
    for (const value of [
      null,
      {},
      { ...reference, sessionID: "../../bad" },
      { ...reference, updatedAt: Infinity },
      { ...reference, updatedAt: 1e20 },
      { ...reference, summary: {} },
    ]) {
      expect(readSessionReference({ sessionReference: value })).toBeUndefined()
    }
    expect(readSessionReference(undefined)).toBeUndefined()
  })
})
