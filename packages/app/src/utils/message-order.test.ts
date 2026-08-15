import { describe, expect, test } from "bun:test"
import { compareMessageToId, compareMessages, sortMessages } from "./message-order"

describe("message-order", () => {
  test("sorts by created time when ids wrap", () => {
    const newer = { id: "msg_003306f69001new", time: { created: 1786759901110 } }
    const older = { id: "msg_feaeca33f001old", time: { created: 1786352804770 } }

    expect(compareMessages(newer, older)).toBe(1)
    expect(sortMessages([newer, older]).map((item) => item.id)).toEqual([older.id, newer.id])
  })

  test("falls back to id order when created times are missing or equal", () => {
    expect(compareMessages({ id: "msg_a" }, { id: "msg_b" })).toBe(-1)
    expect(
      compareMessages({ id: "msg_b", time: { created: 10 } }, { id: "msg_a", time: { created: 10 } }),
    ).toBe(1)
  })

  test("keeps input order when created times are absent", () => {
    const list = [{ id: "u1" }, { id: "a3" }, { id: "a1" }]
    expect(sortMessages(list)).toBe(list)
  })

  test("compares against a boundary id using that message's created time", () => {
    const messages = [
      { id: "msg_00new", time: { created: 200 } },
      { id: "msg_feold", time: { created: 100 } },
    ]

    expect(compareMessageToId(messages, messages[0]!, "msg_feold")).toBe(1)
    expect(compareMessageToId(messages, messages[1]!, "msg_00new")).toBe(-1)
  })
})
