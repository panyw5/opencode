import { describe, expect, test } from "bun:test"
import {
  collectSkillMarkdownPaths,
  parseSkillMarketIndex,
  probeSkillMarketPath,
  resolveNestedSkillPaths,
  skillMarketContentUrls,
  skillMarketIndexSources,
  loadSkillMarketIndex,
} from "./config-skill-market"

describe("skill market nested SKILL.md discovery", () => {
  test("collects SKILL.md files under category folders", () => {
    const paths = collectSkillMarkdownPaths([
      { path: "README.md", type: "blob" },
      { path: "skills/engineering/code-review/SKILL.md", type: "blob" },
      { path: "skills/engineering/code-review/agents/openai.yaml", type: "blob" },
      { path: "skills/productivity/grill-me/SKILL.md", type: "blob" },
      { path: "skills/engineering", type: "tree" },
    ])

    expect(paths).toEqual([
      "skills/engineering/code-review/SKILL.md",
      "skills/productivity/grill-me/SKILL.md",
    ])
  })

  test("accepts jsdelivr name fields and strips a leading slash", () => {
    const paths = collectSkillMarkdownPaths([
      { name: "/grill-me/SKILL.md", type: "file" },
      { name: "/skills/engineering/tdd/SKILL.md", type: "file" },
    ])

    expect(paths).toEqual(["grill-me/SKILL.md", "skills/engineering/tdd/SKILL.md"])
  })

  test("keeps files under an explicit repo path prefix", () => {
    const paths = collectSkillMarkdownPaths(
      [
        { path: "skills/claude-science/paper/SKILL.md" },
        { path: "skills/other/review/SKILL.md" },
        { path: "docs/SKILL.md" },
      ],
      { root: "skills/claude-science" },
    )

    expect(paths).toEqual(["skills/claude-science/paper/SKILL.md"])
  })

  test("descends into a nested skills/ folder when the configured root has no SKILL.md", () => {
    const paths = resolveNestedSkillPaths(
      ["package.json", "skills/engineering/tdd/SKILL.md", "skills/productivity/teach/SKILL.md"],
      undefined,
    )

    expect(paths).toEqual(["skills/engineering/tdd/SKILL.md", "skills/productivity/teach/SKILL.md"])
  })

  test("auto-selects skills/ when a repo path prefix itself contains no SKILL.md", () => {
    const paths = resolveNestedSkillPaths(
      ["packages/app/README.md", "packages/app/skills/review/SKILL.md"],
      "packages/app",
    )

    expect(paths).toEqual(["packages/app/skills/review/SKILL.md"])
  })
})

describe("skill market index parsers", () => {
  test("parses an ungh file listing", () => {
    const paths = parseSkillMarketIndex("ungh", {
      files: [
        { path: "skills/engineering/code-review/SKILL.md" },
        { path: "skills/engineering/code-review/agents/openai.yaml" },
      ],
    })

    expect(paths).toEqual(["skills/engineering/code-review/SKILL.md"])
  })

  test("parses a github recursive tree and ignores truncated payloads", () => {
    expect(
      parseSkillMarketIndex("github", {
        truncated: true,
        tree: [{ path: "skills/tdd/SKILL.md", type: "blob" }],
      }),
    ).toEqual([])

    expect(
      parseSkillMarketIndex("github", {
        tree: [
          { path: "skills/engineering", type: "tree" },
          { path: "skills/engineering/tdd/SKILL.md", type: "blob" },
        ],
      }),
    ).toEqual(["skills/engineering/tdd/SKILL.md"])
  })

  test("builds content urls with jsdelivr first and github raw as fallback", () => {
    expect(skillMarketContentUrls("mattpocock/skills", "main", "skills/engineering/tdd/SKILL.md")).toEqual([
      "https://cdn.jsdelivr.net/gh/mattpocock/skills@main/skills/engineering/tdd/SKILL.md",
      "https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/tdd/SKILL.md",
    ])
    expect(skillMarketIndexSources("mattpocock/skills", "main").map((item) => item.kind)).toEqual([
      "ungh",
      "github",
      "jsdelivr",
    ])
  })
})

describe("skill market index loading", () => {
  test("skips a stale jsdelivr listing and uses the nested github tree", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("ungh.cc")) return new Response("nope", { status: 500 })
      if (url.includes("api.github.com")) {
        return Response.json({
          tree: [
            { path: "skills/engineering/code-review/SKILL.md", type: "blob" },
            { path: "skills/productivity/grill-me/SKILL.md", type: "blob" },
          ],
        })
      }
      if (url.includes("data.jsdelivr.com")) {
        return Response.json({
          files: [{ name: "/grill-me/SKILL.md", type: "file" }],
        })
      }
      if (url.endsWith("/grill-me/SKILL.md")) return new Response("missing", { status: 404 })
      if (url.includes("skills/engineering/code-review/SKILL.md")) {
        return new Response("---\nname: code-review\n---\n", { status: 200 })
      }
      return new Response("missing", { status: 404 })
    }

    const result = await loadSkillMarketIndex({ repo: "mattpocock/skills" }, fetcher)
    expect(result.source).toBe("github")
    expect(result.paths).toEqual([
      "skills/engineering/code-review/SKILL.md",
      "skills/productivity/grill-me/SKILL.md",
    ])
  })

  test("probe rejects stale skill paths", async () => {
    const fetcher: typeof fetch = async () => new Response("missing", { status: 404 })
    expect(await probeSkillMarketPath(fetcher, "mattpocock/skills", "main", "grill-me/SKILL.md")).toBe(false)
  })
})
