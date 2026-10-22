import { frontmatterData } from "./config-frontmatter"

export function skillTemplate(title: string) {
  const name = title.trim()
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    'description: "Describe when to use this skill."',
    "---",
    "",
    name ? `# ${name}` : "# New Skill",
    "",
    "Add instructions, workflows, and examples here.",
    "",
  ].join("\n")
}

export function skillDraftFromText(text: string) {
  return { text, title: frontmatterData(text)?.name ?? "" }
}

export function renameSkillDraft(text: string, previous: string, title: string) {
  if (text === skillTemplate(previous)) return skillTemplate(title)
  const hit = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const value = `name: ${JSON.stringify(title.trim())}`
  if (!hit) {
    const nl = text.includes("\r\n") ? "\r\n" : "\n"
    return `---${nl}${value}${nl}---${nl}${text}`
  }
  // Replace the entire name field, including a possible YAML block scalar.
  const block = hit[2]
  const field = /^name:[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*|[ \t]*(?=\r?\n|$)))*/m
  const next = field.test(block) ? block.replace(field, () => value) : `${value}${hit[1]}${block}`
  return `---${hit[1]}${next}${hit[1]}---${hit[0].endsWith("\n") ? hit[1] : ""}${text.slice(hit[0].length)}`
}
