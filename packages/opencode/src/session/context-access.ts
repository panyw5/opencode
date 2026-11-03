import path from "node:path"
import { realpathSync } from "node:fs"
import { Effect } from "effect"
import { linkedSessionIDs, projectReadAllowed } from "@opencode-ai/core/session-context-access"
import * as Log from "@opencode-ai/core/util/log"
import { Permission } from "@/permission"
import type { Session } from "./session"
import { SessionID } from "./schema"

const log = Log.create({ service: "session.context-access" })

export function containsRealPath(directory: string, target: string) {
  try {
    const relative = path.relative(realpathSync.native(directory), realpathSync.native(target))
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  } catch {
    // Missing or inaccessible paths must use normal permission confirmation.
    return false
  }
}

export const readRules = Effect.fn("SessionContextAccess.readRules")(function* (input: {
  tool: string
  request: Omit<Permission.Request, "id" | "sessionID" | "tool">
  session: Session.Info
  rules: Permission.Ruleset
  getSession: Session.Interface["get"]
}) {
  const req = input.request
  if (req.permission !== "external_directory" || !["read", "glob", "grep"].includes(input.tool)) return []
  const target = req.metadata.filepath
  if (typeof target !== "string") return []
  // An explicit deny remains a deny; this grant only removes directory prompts.
  if (req.patterns.some((pattern) => Permission.evaluate(req.permission, pattern, input.rules).action === "deny")) {
    log.info("project read denied by existing policy", { sessionID: input.session.id, tool: input.tool })
    return []
  }
  for (const id of linkedSessionIDs(input.session.permission)) {
    if (!projectReadAllowed(input.session.permission, id)) continue
    const source = yield* input.getSession(SessionID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!source) {
      log.warn("linked project source unavailable", { sessionID: input.session.id, sourceSessionID: id })
      continue
    }
    if (!containsRealPath(source.directory, target)) continue
    log.info("linked project read authorized", {
      sessionID: input.session.id,
      sourceSessionID: id,
      tool: input.tool,
      target,
    })
    return req.patterns.map((pattern) => ({ permission: req.permission, pattern, action: "allow" as const }))
  }
  log.info("linked project read requires confirmation", { sessionID: input.session.id, tool: input.tool, target })
  return []
})
