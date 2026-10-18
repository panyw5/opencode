import { Component, createMemo } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { useSkills } from "@/context/skills"
import { skill } from "@/components/status-popover-data"
import type { SkillInfo } from "@/utils/skills"

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
        filterKeys={["name", "description"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={group}
        sortGroupsBy={(a, b) =>
          skillGroupRank[a.category as SkillGroup] - skillGroupRank[b.category as SkillGroup]
        }
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
