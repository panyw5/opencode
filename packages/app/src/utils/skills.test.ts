import { describe, expect, test } from "bun:test"
import { cachedSkills, loadSkills, type SkillInfo } from "./skills"
import { deferred } from "@/context/global-sync/session-service-test-utils"

const skill = (name: string): SkillInfo => ({
  name,
  description: `${name} description`,
  location: `/tmp/${name}/SKILL.md`,
  content: `# ${name}`,
})

describe("skills cache", () => {
  test("force refresh during a pending read fetches a new list", async () => {
    const first = deferred<{ data: SkillInfo[] }>()
    const second = deferred<{ data: SkillInfo[] }>()
    let calls = 0
    const sdk = {
      directory: "/tmp/skills-force-pending",
      client: { app: { skills: () => (++calls === 1 ? first.promise : second.promise) } },
    } as Parameters<typeof loadSkills>[0]
    const old = loadSkills(sdk)
    const fresh = loadSkills(sdk, { force: true })
    first.resolve({ data: [skill("old")] })
    await old
    await Promise.resolve()
    expect(calls).toBe(2)
    second.resolve({ data: [skill("fresh")] })
    expect(await fresh).toEqual([skill("fresh")])
    expect(cachedSkills(sdk)).toEqual([skill("fresh")])
  })

  test("force reload bypasses the cached project list", async () => {
    const initial = [skill("initial")]
    const refreshed = [skill("refreshed")]
    let calls = 0
    const sdk = {
      directory: "/tmp/skills-cache-test",
      client: {
        app: {
          skills: async () => ({ data: ++calls === 1 ? initial : refreshed }),
        },
      },
    } as Parameters<typeof loadSkills>[0]

    expect(await loadSkills(sdk)).toEqual(initial)
    expect(await loadSkills(sdk)).toEqual(initial)
    expect(calls).toBe(1)

    expect(await loadSkills(sdk, { force: true })).toEqual(refreshed)
    expect(calls).toBe(2)
    expect(cachedSkills(sdk)).toEqual(refreshed)
  })
})
