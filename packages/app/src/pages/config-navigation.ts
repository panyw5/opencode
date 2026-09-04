import type { SessionBarTab } from "@/context/layout"
import type { SessionTabsTarget } from "@/context/session-tabs"
import { workspaceKey } from "@/pages/layout/helpers"

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
  return resolveConfigReturnTarget(input, tabs, drafts)?.href
}

export function resolveConfigReturnTarget(
  input: Readonly<Partial<ConfigReturnTarget>> | null | undefined,
  tabs: SessionBarTab[],
  drafts: string[],
): ConfigReturnTarget | undefined {
  if (!input || typeof input.href !== "string") return
  if (input.type === "route") {
    if (input.href === "/" || /^\/[^/?#]+\/scheduled(?:[/?#]|$)/.test(input.href) || /^\/scheduled(?:[/?#]|$)/.test(input.href)) {
      return { type: "route", href: input.href }
    }
    return
  }
  if (input.type === "session" && typeof input.id === "string" && typeof input.directory === "string") {
    const id = input.id
    const directory = input.directory
    const found = tabs.some((tab) => tab.id === id && workspaceKey(tab.directory) === workspaceKey(directory))
    return found ? { type: "session", href: input.href, directory, id } : undefined
  }
  if (input.type !== "draft" || typeof input.directory !== "string") return
  const directory = input.directory
  const found = drafts.some((draft) => workspaceKey(draft) === workspaceKey(directory))
  return found ? { type: "draft", href: input.href, directory } : undefined
}
