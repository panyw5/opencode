import { describe, expect, test } from "bun:test"
import { cachedSkills, loadSkills, type SkillInfo } from "./skills"

const skill = (name: string): SkillInfo => ({
  name,
  description: `${name} description`,
  location: `/tmp/${name}/SKILL.md`,
  content: `# ${name}`,
})

describe("skills cache", () => {
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
