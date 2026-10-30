import type { dict } from "@opencode-ai/ui/i18n/en"

const labels = new Map<string, keyof typeof dict>([
  ["read", "ui.tool.read"],
  ["list", "ui.tool.list"],
  ["glob", "ui.tool.glob"],
  ["grep", "ui.tool.grep"],
  ["task", "ui.tool.task"],
  ["webfetch", "ui.tool.webfetch"],
  ["websearch", "ui.tool.websearch"],
  ["codesearch", "ui.tool.codesearch"],
  ["bash", "ui.tool.shell"],
  ["exec", "ui.tool.shell"],
  ["hook", "ui.tool.shell"],
  ["edit", "ui.messagePart.title.edit"],
  ["write", "ui.messagePart.title.write"],
  ["apply_patch", "ui.tool.patch"],
  ["todowrite", "ui.tool.todos"],
  ["todoread", "ui.tool.todos.read"],
  ["present_task", "ui.tool.presentTask"],
  ["question", "ui.tool.questions"],
  ["skill", "ui.tool.skill"],
  ["codex_consult", "ui.tool.codex"],
  ["claude_consult", "ui.tool.claude"],
  ["grok_consult", "ui.tool.grok"],
  ["dsh_consult", "ui.tool.dsh"],
  ["pi_consult", "ui.tool.pi"],
])

export function quickAssistantToolName(tool: string, t: (key: keyof typeof dict) => string) {
  const key = labels.get(tool)
  return key ? t(key) : tool
}
