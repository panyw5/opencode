import { expect, test } from "bun:test"
import { createExtensionApi } from "./api"
import type { ExtensionInfo } from "./types"

const info: ExtensionInfo = {
  id: "test.retry",
  version: "1.0.0",
  displayName: "Retry",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
  server: { hasService: false, hasInstanceHooks: false, runtime: "idle", needsRestart: false },
}

function api(result: unknown) {
  return createExtensionApi({
    globalSDK: {
      url: "http://localhost:4096",
      client: { extension: { retry: async () => result } },
    } as any,
  })
}

test("retry accepts the authoritative runtime status without changing manifest health", async () => {
  expect(await api({ data: info }).retry(info.id)).toEqual(info)
})

test("retry reports API failures and rejects mismatched or unsafe responses", async () => {
  await expect(api({ error: { message: "requires restart" } }).retry(info.id)).rejects.toThrow("requires restart")
  await expect(api({ data: { ...info, id: "wrong.id" } }).retry(info.id)).rejects.toThrow("id mismatch")
  await expect(
    api({ data: { ...info, server: { ...info.server, needsRestart: true } } }).retry(info.id),
  ).rejects.toThrow("restart")
  await expect(
    api({ data: { ...info, web: { base: "https://foreign.invalid/", styles: [], apiVersion: 1 } } }).retry(info.id),
  ).rejects.toThrow("origin")
})
