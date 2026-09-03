export const INJECTION_KINDS = [
  "hook-injection",
  "command-injection",
  "scheduled-injection",
  "project-task-injection",
  "background-task-injection",
  "background-shell-injection",
  "math-worker-event",
] as const

export type InjectionKind = (typeof INJECTION_KINDS)[number]

const kinds: ReadonlySet<string> = new Set(INJECTION_KINDS)

export function isInjectionKind(kind: unknown): kind is InjectionKind {
  return typeof kind === "string" && kinds.has(kind)
}

export function isLegacyBackgroundShellInjection(text: string) {
  return /^Background shell (?:completed|failed)(?::|$)/i.test(text)
}
