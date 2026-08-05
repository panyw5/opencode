import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { eq } from "drizzle-orm"
import type { SessionID } from "@/session/schema"
import { normalizeInjectState, type TaskContextInjectState } from "./context"

/** Read per-session project-task inject bookkeeping (FULL-once per task + snapshots). */
export function getTaskContextInjectState(sessionID: SessionID): TaskContextInjectState {
  return Database.use((db) => {
    const row = db
      .select({ task_context_inject: SessionTable.task_context_inject })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
    return normalizeInjectState(row?.task_context_inject)
  })
}

/** Persist inject bookkeeping after a successful FULL or DELTA inject. */
export function setTaskContextInjectState(sessionID: SessionID, state: TaskContextInjectState): void {
  const normalized = normalizeInjectState(state)
  Database.use((db) => {
    db.update(SessionTable)
      .set({
        task_context_inject: {
          fullInjectedTaskIDs: normalized.fullInjectedTaskIDs,
          snapshots: normalized.snapshots,
        },
        time_updated: Date.now(),
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
  })
}

/**
 * Clear all FULL-injected markers so the next turn re-sends a FULL brief.
 * Used after compaction (history no longer reliably contains prior briefs).
 */
export function clearTaskContextFullInject(sessionID: SessionID): void {
  Database.use((db) => {
    db.update(SessionTable)
      .set({
        task_context_inject: {
          fullInjectedTaskIDs: [],
          snapshots: {},
        },
        time_updated: Date.now(),
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
  })
}

export * as ProjectTaskInjectState from "./inject-state"
