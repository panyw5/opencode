type Copy = {
  heading: string
  scope: string
  intro: string
  background: string
  preserve: string
  info: string
  task: string
  id: string
  lookup: string
  root: string
  description: string
}

const copies: Record<"en" | "zh", Copy> = {
  en: {
    heading: "Project Task Context",
    scope: "Purpose and Scope",
    intro:
      "You are a subagent dispatched by the parent agent. Your task, scope, and deliverables are defined by the delegation prompt above.",
    background:
      "The following is shared background for the parent project, not an additional assignment. Perform only the delegated task; applicable project conventions and protection requirements still apply.",
    preserve:
      "Preserve existing changes by the user and other agents; do not overwrite their work. Report collaboration conflicts to the parent agent.",
    info: "Parent Project Task Information",
    task: "Project task",
    id: "Project task ID",
    lookup: "Use this ID when querying information about this task.",
    root: "Project root",
    description: "Parent Project Task Description",
  },
  zh: {
    heading: "项目任务上下文",
    scope: "用途与边界",
    intro: "你是主智能体派发的子智能体。本次任务、执行范围和交付要求，以上面主智能体撰写的委派 prompt 为准。",
    background:
      "以下内容是父级项目的公共背景，不是对你的额外委派。仅执行主智能体指定的任务；其中适用于本次工作的约定与保护要求仍须遵守。",
    preserve: "保留用户和其他智能体的已有改动；不要覆盖他人成果。发现协作冲突时向主智能体报告。",
    info: "父级项目任务信息",
    task: "项目任务",
    id: "项目任务 ID",
    lookup: "查询本任务相关信息时，使用此 ID",
    root: "项目根目录",
    description: "父级项目任务描述",
  },
}

export function projectTaskContextLocale(locale?: string): "en" | "zh" {
  return locale === "zh" || locale === "zht" ? "zh" : "en"
}

export function projectTaskContextCopy(locale?: string): Copy {
  return copies[projectTaskContextLocale(locale)]
}
