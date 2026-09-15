import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { WechatStorage, AccountLockedError } from "../../src/channel/wechat-storage"

test("private credentials, precise contexts and account lock", async () => {
  await using tmp = await tmpdir()
  const storage = new WechatStorage(path.join(tmp.path, "private"))
  const credentials = { botId: "bot", scannerUserId: "user", token: "secret", baseUrl: "https://ilinkai.weixin.qq.com" }
  await storage.saveCredentials("../../channel", credentials)
  expect(await storage.loadCredentials("../../channel")).toEqual(credentials)
  const files = await fs.readdir(path.join(storage.root, "channels"))
  expect(files[0]).not.toContain("channel")
  expect((await fs.stat(path.join(storage.root, "channels", files[0]))).mode & 0o777).toBe(0o600)
  expect((await fs.stat(storage.root)).mode & 0o777).toBe(0o700)
  await storage.saveContext("bot", "user", { token: "one", messageId: "1", timestamp: 2 })
  await storage.saveContext("bot", "user", { token: "old", messageId: "0", timestamp: 1 })
  expect((await storage.loadContext("bot", "user"))!.token).toBe("one")
  expect(await storage.loadContext("bot", "user", "unknown")).toBeUndefined()
  expect(await storage.loadContext("other", "user")).toBeUndefined()
  const release = await storage.acquireLock("bot")
  await expect(storage.acquireLock("bot")).rejects.toBeInstanceOf(AccountLockedError)
  await release()
  await release()
  await (await storage.acquireLock("bot"))()
})
test("stale login guard does not replace credentials", async () => {
  await using tmp = await tmpdir()
  const storage = new WechatStorage(tmp.path)
  const value = { botId: "bot", scannerUserId: "user", token: "original", baseUrl: "https://ilinkai.weixin.qq.com" }
  await storage.saveCredentials("c", value)
  await expect(storage.saveCredentials("c", { ...value, token: "stale" }, () => false)).rejects.toThrow()
  expect((await storage.loadCredentials("c"))!.token).toBe("original")
})
