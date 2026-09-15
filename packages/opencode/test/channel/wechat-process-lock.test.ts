import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { AccountLockedError, WechatStorage } from "../../src/channel/wechat-storage"

test("a live independent monitor cannot be displaced and an exited owner recovers", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "private")
  const modulePath = path.resolve(import.meta.dir, "../../src/channel/wechat-storage.ts")
  const source = `
    const { WechatStorage } = await import(${JSON.stringify(modulePath)});
    const store = new WechatStorage(${JSON.stringify(root)});
    await store.acquireLock("shared-account");
    console.log("LOCKED");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(0));
  `
  const child = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const reader = child.stdout.getReader()
  try {
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toContain("LOCKED")
    const store = new WechatStorage(root)
    await expect(store.acquireLock("shared-account")).rejects.toBeInstanceOf(AccountLockedError)
    child.stdin.write("exit without releasing\n")
    child.stdin.end()
    expect(await child.exited).toBe(0)
    const release = await store.acquireLock("shared-account")
    await release()
    await (
      await new WechatStorage(root).acquireLock("shared-account")
    )()
  } finally {
    reader.releaseLock()
    if (child.exitCode === null) child.kill()
    await child.exited
  }
})
