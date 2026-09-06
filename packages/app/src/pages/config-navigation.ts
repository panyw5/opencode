import type { SessionBarDraft, SessionBarTab } from "@/context/layout"
import type { SessionTabsTarget } from "@/context/session-tabs"
import { workspaceKey } from "@/pages/layout/helpers"

export type ConfigReturnTarget =
  | { type: "session"; href: string; directory: string; id: string }
  | { type: "draft"; href: string; directory: string; id: string }
  | { type: "route"; href: string }

export function createConfigReturnTarget(input: {
  pathname: string
  search?: string
  hash?: string
  directory?: string
  id?: string
  draftID?: string
  session: boolean
}): ConfigReturnTarget | undefined {
  const href = `${input.pathname}${input.search ?? ""}${input.hash ?? ""}`
  if (input.session && input.directory && input.id) {
    return { type: "session", href, directory: input.directory, id: input.id }
  }
  if (input.session && input.directory && input.draftID) {
    return { type: "draft", href, directory: input.directory, id: input.draftID }
  }
  if (input.pathname === "/" || /\/scheduled\/?$/.test(input.pathname)) return { type: "route", href }
}

export function resolveConfigReturnHref(
  input: Readonly<Partial<ConfigReturnTarget>> | null | undefined,
  tabs: SessionBarTab[],
  drafts: SessionBarDraft[],
) {
  return resolveConfigReturnTarget(input, tabs, drafts)?.href
}

export function resolveConfigReturnTarget(
  input: Readonly<Partial<ConfigReturnTarget>> | null | undefined,
  tabs: SessionBarTab[],
  drafts: SessionBarDraft[],
): ConfigReturnTarget | undefined {
  if (!input || typeof input.href !== "string") return
  if (input.type === "route") {
    if (
      input.href === "/" ||
      /^\/[^/?#]+\/scheduled(?:[/?#]|$)/.test(input.href) ||
      /^\/scheduled(?:[/?#]|$)/.test(input.href)
    ) {
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
  if (input.type !== "draft" || typeof input.directory !== "string" || typeof input.id !== "string") return
  const directory = input.directory
  const id = input.id
  const found = drafts.some((draft) => draft.id === id && workspaceKey(draft.directory) === workspaceKey(directory))
  return found ? { type: "draft", href: input.href, directory, id } : undefined
}
