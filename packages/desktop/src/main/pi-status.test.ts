import { describe, expect, test } from "bun:test"
import { getPiInfo, parsePiSettings } from "./pi-status"

describe("Pi executable probe", () => {
  test("exposes model preferences, never auth or arbitrary settings", () => {
    expect(
      parsePiSettings(JSON.stringify({ defaultProvider: "test", defaultModel: "model", apiKey: "secret" })),
    ).toEqual([
      { label: "defaultProvider", value: "test" },
      { label: "defaultModel", value: "model" },
    ])
    expect(parsePiSettings("[]")).toEqual([])
  })
  test("honors an explicit JavaScript CLI entry point", async () => {
    const binaryPath = new URL("../../../opencode/test/fixture/pi-rpc.mjs", import.meta.url).pathname
    const info = await getPiInfo({ enabled: true, binaryPath, configHome: "/tmp/nonexistent-pi-test-home" })
    expect(info).toMatchObject({
      binaryPath,
      installed: true,
      version: "pi-fixture-1.0.4",
      configHome: "/tmp/nonexistent-pi-test-home",
    })
  })
})
