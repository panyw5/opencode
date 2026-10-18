import { Component, createMemo } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { useSkills } from "@/context/skills"
import { skill } from "@/components/status-popover-data"
import type { SkillInfo } from "@/utils/skills"
import { usePrompt, type ContentPart } from "@/context/prompt"
import { useDialog } from "@opencode-ai/ui/context/dialog"

type SkillGroup = "project" | "global" | "plugin" | "builtin"
type SkillItem = SkillInfo & { meta: ReturnType<typeof skill> }

const skillGroupRank: Record<SkillGroup, number> = {
  project: 0,
  global: 1,
  plugin: 2,
  builtin: 3,
}

export const DialogSelectSkill: Component = () => {
  const global = useGlobalSync()
  const skills = useSkills()
  const language = useLanguage()
  const prompt = usePrompt()
  const dialog = useDialog()

  const items = createMemo(() =>
    skills
      .list()
      .map((item) => ({ ...item, meta: skill(item, global.data.project) }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  )
  const group = (item: SkillItem): SkillGroup => {
    if (item.location === "<built-in>") return "builtin"
    if (/(?:^|[/:])plugins?(?:[/:]|$)/i.test(item.location.replace(/\\/g, "/"))) return "plugin"
    return item.meta.scope === "project" ? "project" : "global"
  }

  const select = (item: SkillItem | undefined) => {
    if (!item) return
    const current = prompt.current()
    const cursor =
      prompt.cursor() ?? current.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
    const name = item.name
    const content = `/${name}`
    const before = current
      .filter((part) => part.type !== "image")
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
      .slice(0, cursor)
    const prefix = before.length > 0 && !/\s$/.test(before) ? " " : ""
    const suffix = " "
    const inserted = prefix.length + content.length + suffix.length
    let offset = 0
    let added = false
    const next: ContentPart[] = current.flatMap((part): ContentPart[] => {
      if (part.type === "image") return [part]
      if (added) return [part]
      const length = "content" in part ? part.content.length : 0
      if (cursor > offset + length) {
        offset += length
        return [part]
      }

      const local = Math.max(0, cursor - offset)
      const parts = []
      if (part.type === "text" && local > 0) {
        parts.push({ ...part, content: part.content.slice(0, local), end: part.start + local })
      }
      if (prefix) parts.push({ type: "text" as const, content: prefix, start: cursor, end: cursor + prefix.length })
      parts.push({
        type: "skill" as const,
        name,
        content,
        start: cursor + prefix.length,
        end: cursor + prefix.length + content.length,
      })
      parts.push({
        type: "text" as const,
        content: suffix,
        start: cursor + prefix.length + content.length,
        end: cursor + inserted,
      })
      if (part.type === "text" && local < length) {
        parts.push({ ...part, content: part.content.slice(local), start: cursor + inserted, end: part.end + inserted })
      } else if (local === 0 && part.type !== "text") {
        parts.push(part)
      }
      added = true
      offset += length
      return parts
    })

    if (!added) {
      const start = cursor + prefix.length
      next.push(
        ...(prefix ? [{ type: "text" as const, content: prefix, start: cursor, end: start }] : []),
        { type: "skill" as const, name, content, start, end: start + content.length },
        {
          type: "text" as const,
          content: suffix,
          start: start + content.length,
          end: start + content.length + suffix.length,
        },
      )
    }
    console.debug("[prompt-skill] selected", { name, cursor, prefix: !!prefix })
    prompt.set(next, cursor + inserted)
    console.debug("[prompt-skill] inserted", { name, parts: next.length, cursor: cursor + inserted })
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("dialog.skill.title")}
      description={language.t("dialog.skill.description", { count: items().length })}
      containerStyle={{ height: "min(calc(100vh - 32px), 720px)" }}
    >
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.skill.empty")}
        key={(x) => x?.name ?? ""}
        items={items}
        onSelect={select}
        filterKeys={["name", "description"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={group}
        sortGroupsBy={(a, b) => skillGroupRank[a.category as SkillGroup] - skillGroupRank[b.category as SkillGroup]}
        groupHeader={(group) => (
          <span>{language.t(`dialog.skill.group.${group.category}` as `dialog.skill.group.${SkillGroup}`)}</span>
        )}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span class="text-14-regular text-text-strong whitespace-nowrap">/{item.name}</span>
            <span class="text-12-regular text-text-weak whitespace-nowrap">{item.meta.scope}</span>
            <span class="text-12-regular text-text-weak whitespace-nowrap">{item.meta.source ?? "-"}</span>
            <span class="text-14-regular text-text-weak truncate">{item.description}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
