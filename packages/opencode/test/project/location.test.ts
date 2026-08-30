import { describe, expect, test } from "bun:test"
import { Database } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { ProjectLocation } from "@/project/location"
import { ProjectAliasID, ProjectID } from "@/project/schema"
import { ProjectAliasTable } from "@/project/location.sql"
import { eq } from "drizzle-orm"
import { ProjectAlias } from "@/project/alias"

describe("ProjectLocation", () => {
  test("normalizes transport variants without accepting local paths", () => {
    expect(ProjectAlias.normalizeRemoteUrl("git@github.com:OpenCodeAI/opencode.git")).toBe(
      "github.com/OpenCodeAI/opencode",
    )
    expect(ProjectAlias.normalizeRemoteUrl("https://github.com/OpenCodeAI/opencode.git/")).toBe(
      "github.com/OpenCodeAI/opencode",
    )
    expect(ProjectAlias.normalizeRemoteUrl("ssh://git@github.com/OpenCodeAI/opencode.git")).toBe(
      "github.com/OpenCodeAI/opencode",
    )
    expect(ProjectAlias.normalizeRemoteUrl("/tmp/local-repository")).toBeUndefined()
    expect(ProjectAlias.normalizeRemoteUrl("file:///tmp/local-repository")).toBeUndefined()
  })

  test("upserts one stable location per canonical directory", () => {
    const now = Date.now()
    const projectID = ProjectID.make(`location-project-${crypto.randomUUID()}`)
    const directory = `/tmp/location-${crypto.randomUUID()}`
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: directory,
          sandboxes: [],
          time_created: now,
          time_updated: now,
        })
        .run(),
    )

    const first = ProjectLocation.upsert({
      projectID,
      directory,
      canonicalDirectory: directory,
      kind: "directory",
      vcsState: "none",
      worktreeRoot: directory,
    })
    const second = ProjectLocation.upsert({
      projectID,
      directory,
      canonicalDirectory: directory,
      kind: "git_main",
      vcsType: "git",
      vcsState: "unborn",
      worktreeRoot: directory,
      gitCommonDir: `${directory}/.git`,
    })

    expect(second.id).toBe(first.id)
    expect(second.projectID).toBe(projectID)
    expect(second.kind).toBe("git_main")
    expect(second.vcsState).toBe("unborn")
    expect(ProjectLocation.getByCanonicalDirectory(directory)).toEqual(second)

    const aliasID = ProjectAliasID.ascending()
    Database.use((db) =>
      db
        .insert(ProjectAliasTable)
        .values({
          id: aliasID,
          project_id: projectID,
          kind: "git_marker",
          value: `${directory}/.git/opencode`,
          confidence: "high",
          source_location_id: second.id,
          time_created: now,
          time_updated: now,
          time_last_seen: now,
        })
        .run(),
    )
    const alias = Database.use((db) =>
      db.select().from(ProjectAliasTable).where(eq(ProjectAliasTable.id, aliasID)).get(),
    )
    expect(alias?.source_location_id).toBe(second.id)
  })

  test("returns a remote candidate only while it identifies one project", () => {
    const now = Date.now()
    const remote = "github.com/example/repository"
    const first = ProjectID.make(`alias-project-${crypto.randomUUID()}`)
    const second = ProjectID.make(`alias-project-${crypto.randomUUID()}`)
    Database.use((db) => {
      for (const id of [first, second]) {
        db.insert(ProjectTable)
          .values({
            id,
            worktree: `/tmp/${id}`,
            sandboxes: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      }
    })

    ProjectAlias.upsert({ projectID: first, kind: "remote_url", value: remote, confidence: "medium" })
    expect(ProjectAlias.uniqueProject("remote_url", remote)).toBe(first)

    ProjectAlias.upsert({ projectID: second, kind: "remote_url", value: remote, confidence: "medium" })
    expect(ProjectAlias.uniqueProject("remote_url", remote)).toBeUndefined()
  })
})
