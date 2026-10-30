import { expect, test } from "bun:test"
import type { Cookie } from "electron"
import { GPT_PRO_PARTITION } from "@opencode-ai/util/gpt-pro"
import { GptProCredentialProfiles } from "./gpt-pro-credential-profiles"
import type { SessionCookie } from "./gpt-pro-session-cookies"

const cookie: SessionCookie = {
  name: "__Secure-next-auth.session-token",
  value: "SYNTHETIC",
  domain: ".chatgpt.com",
  path: "/",
  secure: true,
  httpOnly: true,
  hostOnly: false,
  sameSite: "lax",
  session: true,
}
function fixture() {
  const jars = new Map<string, Cookie[]>()
  const persisted: string[][] = []
  const disposed: string[] = []
  let fail = false
  let cleanupFailure = false
  const profiles = new GptProCredentialProfiles({
    create(id) {
      jars.set(id, [])
      return {
        cookies: {
          get: async () => jars.get(id)!,
          set: async (cookie) => {
            jars.get(id)!.push(cookie as Cookie)
          },
          remove: async (_url, name) => {
            jars.set(
              id,
              jars.get(id)!.filter((c) => c.name !== name),
            )
          },
          flushStore: async () => {},
        },
        dispose: async () => {
          if (cleanupFailure) throw Error("profile cleanup unavailable")
          disposed.push(id)
          jars.delete(id)
        },
      }
    },
    persist: async (cookies) => {
      if (fail) throw Error("secure storage fault")
      persisted.push(cookies.map((c) => c.value))
    },
    changed: () => {},
    log: () => {},
  })
  jars.get(GPT_PRO_PARTITION)!.push({ ...cookie, value: "OLD" })
  return {
    profiles,
    jars,
    persisted,
    disposed,
    fail: () => {
      fail = true
    },
    failCleanup: () => { cleanupFailure = true },
    recoverCleanup: () => { cleanupFailure = false },
  }
}
test("candidate installation never removes old Cookies or writes the vault before verification", async () => {
  const f = fixture()
  const id = await f.profiles.stage([cookie])
  expect(f.profiles.profileID()).toBe(GPT_PRO_PARTITION)
  expect(f.jars.get(GPT_PRO_PARTITION)![0].value).toBe("OLD")
  expect(f.jars.get(id)![0].value).toBe("SYNTHETIC")
  expect(f.persisted).toEqual([])
  await f.profiles.discard(id)
})
test("retirement failures retain the profile bound and permit explicit cleanup recovery", async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) await f.profiles.promote(await f.profiles.stage([cookie]), () => {})
  f.failCleanup()
  await expect(f.profiles.collect(() => false)).rejects.toThrow("cleanup unavailable")
  await expect(f.profiles.stage([cookie])).rejects.toThrow("Close retained")
  f.recoverCleanup()
  await f.profiles.collect(() => false)
  expect(f.jars.size).toBe(1)
  const candidate = await f.profiles.stage([cookie])
  await f.profiles.discard(candidate)
})
test("promotion persists credentials before publishing execution and retains the original jar", async () => {
  const f = fixture()
  const id = await f.profiles.stage([cookie])
  await f.profiles.promote(id, () => {
    expect(f.persisted).toEqual([["SYNTHETIC"]])
    expect(f.profiles.profileID()).toBe(GPT_PRO_PARTITION)
  })
  expect(f.profiles.profileID()).toBe(id)
  expect(f.jars.get(GPT_PRO_PARTITION)![0].value).toBe("OLD")
})
test("execution commit failure restores the old vault and never switches profiles", async () => {
  const f = fixture()
  const id = await f.profiles.stage([cookie])
  await expect(
    f.profiles.promote(id, () => {
      throw Error("execution write failed")
    }),
  ).rejects.toThrow("execution write failed")
  expect(f.profiles.profileID()).toBe(GPT_PRO_PARTITION)
  expect(f.persisted).toEqual([["SYNTHETIC"], ["OLD"]])
  f.profiles.retain(id)
  await f.profiles.collect(() => false)
})

test("an old Cookie snapshot awaiting I/O cannot overwrite the promoted vault", async () => {
  const f = fixture()
  const jar = f.profiles.jar()
  const get = jar.get
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  jar.get = async (filter) => {
    await gate
    return get(filter)
  }
  const writing = f.profiles.persist()
  await Promise.resolve()
  const id = await f.profiles.stage([cookie])
  const promoting = f.profiles.promote(id, () => {})
  release()
  await Promise.all([writing, promoting])
  expect(f.persisted).toEqual([["SYNTHETIC"]])
  expect(f.profiles.profileID()).toBe(id)
})
test("unavailable secure storage cannot authorize execution or promote a candidate", async () => {
  const f = fixture()
  const id = await f.profiles.stage([cookie])
  f.fail()
  let committed = false
  await expect(
    f.profiles.promote(id, () => {
      committed = true
    }),
  ).rejects.toThrow()
  expect(committed).toBe(false)
  expect(f.profiles.profileID()).toBe(GPT_PRO_PARTITION)
})
test("retained user pages are bounded; collecting closed retired pages never clears the active jar", async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) {
    const id = await f.profiles.stage([cookie])
    await f.profiles.promote(id, () => {})
  }
  await expect(f.profiles.stage([cookie])).rejects.toThrow("Close retained")
  const active = f.profiles.profileID()
  await f.profiles.collect(() => false)
  expect(f.jars.size).toBe(1)
  expect(f.jars.has(active)).toBe(true)
})
