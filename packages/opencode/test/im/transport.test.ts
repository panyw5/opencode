import { describe, expect, test } from "bun:test"
import { registry, transportCapabilities } from "../../src/im/transport"
import type { IMTransport } from "../../src/im/model"

function transport(channelName: string): IMTransport {
  return {
    platform: "feishu",
    channelName,
    capabilities: transportCapabilities("feishu"),
    sendText: async () => ({ timeSent: Date.now() }),
  }
}

describe("IM transport registry", () => {
  test("does not unregister a replacement transport", () => {
    const oldTransport = transport("restart-test")
    const newTransport = transport("restart-test")
    registry.register(oldTransport)
    registry.register(newTransport)
    registry.unregister("restart-test", oldTransport)
    expect(registry.get("restart-test")).toBe(newTransport)
    registry.unregister("restart-test", newTransport)
    expect(registry.get("restart-test")).toBeUndefined()
  })
})
