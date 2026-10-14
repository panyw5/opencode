import { Database, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { SessionID } from "@/session/schema"

/** Only ancestors may read descendants. Directory and project boundaries remain exact. */
export function gptProReadOwners(owner: string): string[] {
  const separator = owner.lastIndexOf("\n")
  if (separator < 0) return [owner]
  const directory = owner.slice(0, separator)
  const id = owner.slice(separator + 1)
  return Database.use((db) => {
    const root = db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionID.make(id)))
      .get()
    if (!root || AppFileSystem.resolve(root.directory) !== directory) return [owner]
    const rows = db
      .select({ id: SessionTable.id, parentID: SessionTable.parent_id, directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.project_id, root.project_id))
      .all()
    const descendants = new Set<string>([id])
    for (let changed = true; changed && descendants.size < 512; ) {
      changed = false
      for (const row of rows) {
        if (
          !row.parentID ||
          !descendants.has(row.parentID) ||
          descendants.has(row.id) ||
          AppFileSystem.resolve(row.directory) !== directory
        )
          continue
        descendants.add(row.id)
        changed = true
        if (descendants.size >= 512) break
      }
    }
    return [...descendants].map((id) => `${directory}\n${id}`)
  })
}
