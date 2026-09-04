import type { SessionBarTab } from "@/context/layout"
import type { SessionTabsTarget } from "@/context/session-tabs"
import { sameWorkspacePath } from "@/pages/layout/helpers"

export type ConfigReturnTarget =
  | { type: "session"; href: string; directory: string; id: string }
  | { type: "draft"; href: string; directory: string }
  | { type: "route"; href: string }

export function createConfigReturnTarget(input: {
  pathname: string
  search?: string
  hash?: string
  directory?: string
  id?: string
  session: boolean
}): ConfigReturnTarget | undefined {
  const href = `${input.pathname}${input.search ?? ""}${input.hash ?? ""}`
  if (input.session && input.directory && input.id) {
    return { type: "session", href, directory: input.directory, id: input.id }
  }
  if (input.session && input.directory) return { type: "draft", href, directory: input.directory }
  if (input.pathname === "/" || /\/scheduled\/?$/.test(input.pathname)) return { type: "route", href }
}

export function resolveConfigReturnHref(
  input: Readonly<Partial<ConfigReturnTarget>> | null | undefined,
  tabs: SessionBarTab[],
  drafts: string[],
) {
  if (!input || typeof input.href !== "string") return
  if (input.type === "route") return input.href
  if (input.type === "session" && typeof input.id === "string" && typeof input.directory === "string") {
    const id = input.id
    const directory = input.directory
    return tabs.some((tab) => tab.id === id && sameWorkspacePath(tab.directory, directory)) ? input.href : undefined
  }
  if (input.type !== "draft" || typeof input.directory !== "string") return
  const directory = input.directory
  return drafts.some((draft) => sameWorkspacePath(draft, directory)) ? input.href : undefined
}
