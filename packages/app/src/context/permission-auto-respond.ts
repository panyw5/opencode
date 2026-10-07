import { base64Encode } from "@opencode-ai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

/**
 * Browser actions that act on the page on the agent's behalf. Session-level
 * auto-accept must never silently approve these (P2-S-08): the user always
 * sees an explicit prompt for clicks and typing, even with auto-accept on.
 * Passive reads (read/screenshot/console) and navigation flow through.
 */
const INTERACTIVE_BROWSER_ACTIONS = new Set(["click", "type"])

export function isInteractiveBrowserPermission(permission: {
  permission: string
  metadata?: { [key: string]: unknown }
}) {
  if (!permission.permission.startsWith("browser_")) return false
  const action = permission.metadata?.action
  return typeof action === "string" && INTERACTIVE_BROWSER_ACTIONS.has(action)
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string; permission?: string; metadata?: { [key: string]: unknown } },
  directory?: string,
) {
  if (
    permission.permission !== undefined &&
    isInteractiveBrowserPermission(permission as { permission: string; metadata?: { [key: string]: unknown } })
  )
    return false
  const value = sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? false
}
