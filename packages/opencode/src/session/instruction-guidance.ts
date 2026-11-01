import { Schema } from "effect"
import { createPatch } from "diff"
import { InstructionSource } from "./instruction-source"

export const File = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  loaded: Schema.optional(Schema.Boolean),
})
export const Files = Schema.Array(File)
export type File = typeof File.Type
export const SkillEntry = Schema.Struct({ name: Schema.String, description: Schema.String, location: Schema.String })
export const Skills = Schema.Array(SkillEntry)
export type SkillEntry = typeof SkillEntry.Type
export const renderFiles = (files: readonly File[]) =>
  files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
export function updateFiles(previous: readonly File[], current: readonly File[]) {
  const diff = InstructionSource.diffByKey(
    previous,
    current,
    (file) => file.path,
    (a, b) => a.content !== b.content,
  )
  if (
    !diff.added.length &&
    !diff.removed.length &&
    !diff.changed.length &&
    previous.map((file) => file.path).join("\0") !== current.map((file) => file.path).join("\0")
  )
    return `The instruction source order changed. This ordered list replaces the previous one:\n${renderFiles(current)}`
  return [
    ...diff.removed.map((file) => `The instructions from ${file.path} no longer apply.`),
    ...diff.added.map((file) => `New instructions apply from:\n${renderFiles([file])}`),
    ...diff.changed.map(({ previous: before, current: after }) => {
      const patch = createPatch(after.path, before.content, after.content, "", "", { context: 3 })
      const text = `The instructions from ${after.path} changed. This update supersedes the previous content:\n\`\`\`diff\n${patch.slice(patch.indexOf("@@")).trimEnd()}\n\`\`\``
      const replacement = `The instructions from ${after.path} changed and replace the previous content:\n${renderFiles([after])}`
      return text.length < replacement.length ? text : replacement
    }),
  ].join("\n\n")
}
const entries = (skills: readonly SkillEntry[]) =>
  skills
    .map(
      (skill) =>
        `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n    <location>${skill.location}</location>\n  </skill>`,
    )
    .join("\n")
export const renderSkills = (skills: readonly SkillEntry[]) =>
  skills.length === 0
    ? ""
    : [
        "Skills provide specialized instructions and workflows for specific tasks.",
        "Use the skill tool to load a skill when a task matches its description. Skills already present as <skill_content> do not need to be loaded again.",
        "<available_skills>",
        entries(skills),
        "</available_skills>",
      ].join("\n")
export function updateSkills(previous: readonly SkillEntry[], current: readonly SkillEntry[]) {
  const diff = InstructionSource.diffByKey(
    previous,
    current,
    (skill) => skill.name,
    (a, b) => a.description !== b.description || a.location !== b.location,
  )
  return [
    ...(diff.added.length
      ? ["New skills are available in addition to those previously listed:", entries(diff.added)]
      : []),
    ...(diff.changed.length
      ? [
          "The following skills replace the previously listed entries with the same names:",
          entries(diff.changed.map((change) => change.current)),
        ]
      : []),
    ...(diff.removed.length
      ? [
          `The following skills are no longer available and must not be used: ${diff.removed.map((skill) => skill.name).join(", ")}.`,
        ]
      : []),
  ].join("\n")
}
export * as InstructionGuidance from "./instruction-guidance"
