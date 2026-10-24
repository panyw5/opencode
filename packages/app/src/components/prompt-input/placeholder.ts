const BASE_PLACEHOLDER_SUGGESTIONS = [
  "prompt.suggestion.hint.sendKeepView",
  "prompt.suggestion.hint.expandEditor",
  "prompt.suggestion.hint.sessionTabMenu",
  "prompt.suggestion.hint.sessionListMenu",
  "prompt.suggestion.hint.newSessionProjectPicker",
  "prompt.suggestion.hint.externalAgents",
  "prompt.suggestion.hint.dragDrop",
  "prompt.suggestion.hint.mentions",
  "prompt.suggestion.hint.stopAfterTool",
  "prompt.suggestion.hint.customizeShortcuts",
  "prompt.suggestion.hint.backgroundTasks",
  "prompt.suggestion.hint.backgroundShell",
  "prompt.suggestion.hint.backgroundShellManager",
  "prompt.suggestion.hint.backgroundSubagent",
  "prompt.suggestion.hint.intervene",
  "prompt.suggestion.hint.advisorIntervention",
  "prompt.suggestion.hint.scheduledTasks",
  "prompt.suggestion.hint.switchProject",
  "prompt.suggestion.hint.worktrees",
  "prompt.suggestion.hint.dropFolder",
  "prompt.suggestion.hint.reorderProjects",
  "prompt.suggestion.hint.questionPanel",
  "prompt.suggestion.hint.sessionStatus",
  "prompt.suggestion.hint.projectTasks",
  "prompt.suggestion.hint.search",
  "prompt.suggestion.hint.filePaths",
  "prompt.suggestion.hint.readingMode",
  "prompt.suggestion.hint.configHub",
  "prompt.suggestion.hint.remoteAccess",
  "prompt.suggestion.hint.quickAssistant",
  "prompt.suggestion.hint.sessionReferences",
  "prompt.suggestion.hint.contextMenus",
] as const

type PromptSuggestionCapabilities = {
  desktop: boolean
  remoteMode?: boolean
  remoteAccess?: boolean
  tempAttachment: boolean
}

type PromptSuggestionKey = (typeof BASE_PLACEHOLDER_SUGGESTIONS)[number] | "prompt.suggestion.hint.tempAttachment"

export function promptPlaceholderSuggestions(input: PromptSuggestionCapabilities): PromptSuggestionKey[] {
  const suggestions = BASE_PLACEHOLDER_SUGGESTIONS.filter((key) => {
    if (key === "prompt.suggestion.hint.expandEditor") return input.desktop
    if (key === "prompt.suggestion.hint.backgroundShell") return !input.remoteMode
    if (key === "prompt.suggestion.hint.backgroundShellManager") return input.desktop && !input.remoteMode
    if (key === "prompt.suggestion.hint.remoteAccess") return input.desktop && !input.remoteMode && !!input.remoteAccess
    return true
  })
  return input.tempAttachment ? ["prompt.suggestion.hint.tempAttachment", ...suggestions] : suggestions
}

type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  suggestion: string
  suggest: boolean
  t: (key: string, params?: Record<string, string>) => string
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.mode === "shell") return input.t("prompt.placeholder.shell")
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  if (!input.suggest) return input.t("prompt.placeholder.simple")
  return input.t("prompt.placeholder.normal", { suggestion: input.suggestion })
}
