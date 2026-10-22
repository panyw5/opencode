import { describe, expect, test } from "bun:test"
import { renameSkillDraft, skillDraftFromText, skillTemplate } from "./config-skill-create"

describe("new skill draft", () => {
  const text =
    "---\nname: make-svg-illustration\ndescription: Use for SVG illustrations.\n---\n\n# Requirement\n\n- Keep these instructions.\n"

  test("takes the title from pasted frontmatter without changing the content", () => {
    expect(skillDraftFromText(text)).toEqual({ title: "make-svg-illustration", text })
  })

  test("tracks renames and clearing the name", () => {
    expect(skillDraftFromText(text.replace("make-svg-illustration", "new-skill")).title).toBe("new-skill")
    for (const value of ['""', "''", "", "   "]) {
      expect(skillDraftFromText(text.replace("make-svg-illustration", value)).title).toBe("")
    }
  })

  test("ignores names in the body or an incomplete frontmatter", () => {
    expect(skillDraftFromText("# Skill\nname: not-metadata").title).toBe("")
    expect(skillDraftFromText("---\nname: unfinished").title).toBe("")
    expect(skillDraftFromText("---\ndescription: example\n---\nname: body").title).toBe("")
  })

  test("supports quoted names, CRLF and folded descriptions", () => {
    const draft =
      "---\r\nname: 'make-svg-illustration'\r\ndescription: >-\r\n  Use for\r\n  illustrations.\r\n---\r\nBody"
    expect(skillDraftFromText(draft)).toEqual({ title: "make-svg-illustration", text: draft })
  })

  test("renames pristine templates", () => {
    expect(renameSkillDraft(skillTemplate(""), "", "test-skill")).toBe(skillTemplate("test-skill"))
  })

  test("renaming via the header preserves edited instructions and metadata", () => {
    const next = renameSkillDraft(text, "make-svg-illustration", "renamed-skill")
    expect(next).toBe(text.replace("name: make-svg-illustration", 'name: "renamed-skill"'))
    expect(skillDraftFromText(next).title).toBe("renamed-skill")
  })

  test("inserts a missing name or frontmatter without replacing the body", () => {
    const withoutName = "---\ndescription: Keep this.\n---\n\n# Body\nname: body-only\n"
    expect(renameSkillDraft(withoutName, "", "test")).toBe(withoutName.replace("---\n", '---\nname: "test"\n'))
    expect(renameSkillDraft("# Body\n", "", "test")).toBe('---\nname: "test"\n---\n# Body\n')
  })

  test("renames block scalar names and preserves CRLF", () => {
    const draft = "---\r\nname: >-\r\n  old-name\r\ndescription: Keep this.\r\n---\r\nBody\r\n"
    expect(renameSkillDraft(draft, "old-name", "test")).toBe(
      '---\r\nname: "test"\r\ndescription: Keep this.\r\n---\r\nBody\r\n',
    )
  })

  test("clearing the header clears the metadata too", () => {
    const next = renameSkillDraft(text, "make-svg-illustration", "")
    expect(skillDraftFromText(next).title).toBe("")
    expect(next.endsWith("- Keep these instructions.\n")).toBe(true)
  })
})
