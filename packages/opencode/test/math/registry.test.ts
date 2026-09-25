import { describe, expect, test as bunTest } from "bun:test"
import { Database as SQLiteDatabase } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { InstanceRef } from "@/effect/instance-ref"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ensureMathProblemIdentity } from "@/math/identity"
import { mathRoot } from "@/math/layout"
import { findByWorker, listByParent, registerProblemWorker } from "@/math/registry"

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer))

describe("math.problem registry", () => {
  it.instance("registers idempotently and resolves by worker/parent", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const projectDir = mathRoot(test.directory, "registry-problem")
      ensureMathProblemIdentity({
        directory: projectDir,
        ownerProjectID: parent.projectID,
        ownerDirectory: parent.directory,
        orchestratorSessionID: parent.id,
      })
      const worker = yield* sessions.create({ title: "worker", agent: "math-worker", parentID: parent.id }).pipe(
        Effect.provideService(InstanceRef, { ...(yield* InstanceRef), directory: projectDir }),
      )
      registerProblemWorker({ parentSessionID: parent.id, workerSessionID: worker.id, problemID: "registry-problem" })
      registerProblemWorker({ parentSessionID: parent.id, workerSessionID: worker.id, problemID: "registry-problem" })
      expect(findByWorker(worker.id)).toMatchObject({ problemID: "registry-problem", workerSessionID: worker.id })
      expect(listByParent(parent.id)).toHaveLength(1)
    }),
  )

  it.instance("rejects a worker mapped to another problem", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const first = mathRoot(test.directory, "registry-a")
      const second = mathRoot(test.directory, "registry-b")
      for (const directory of [first, second]) {
        ensureMathProblemIdentity({ directory, ownerProjectID: parent.projectID, ownerDirectory: parent.directory, orchestratorSessionID: parent.id })
      }
      const worker = yield* sessions.create({ title: "worker", agent: "math-worker", parentID: parent.id }).pipe(
        Effect.provideService(InstanceRef, { ...(yield* InstanceRef), directory: first }),
      )
      registerProblemWorker({ parentSessionID: parent.id, workerSessionID: worker.id, problemID: "registry-a" })
      expect(() => registerProblemWorker({ parentSessionID: parent.id, workerSessionID: worker.id, problemID: "registry-b" })).toThrow()
    }),
  )

  it.instance("rejects forged ownership markers and accepts only matching legacy adoption", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const worker = yield* sessions.create({ title: "worker", agent: "math-worker", parentID: parent.id })
      const forged = mathRoot(test.directory, "forged")
      ensureMathProblemIdentity({
        directory: forged,
        ownerProjectID: "project-forged",
        ownerDirectory: parent.directory,
        orchestratorSessionID: parent.id,
      })
      expect(() => registerProblemWorker({ parentSessionID: parent.id, workerSessionID: worker.id, problemID: "forged" })).toThrow()

      const legacy = mathRoot(test.directory, "legacy-registry")
      ensureMathProblemIdentity({
        directory: legacy,
        ownerProjectID: parent.projectID,
        ownerDirectory: parent.directory,
        orchestratorSessionID: parent.id,
        legacyAdoption: { workerSessionID: worker.id, parentSessionID: parent.id },
      })
      registerProblemWorker({ parentSessionID: parent.id, workerSessionID: worker.id, problemID: "legacy-registry" })
      expect(findByWorker(worker.id)?.legacy).toBe(true)
    }),
  )

  bunTest("applies the registry migration to a fresh SQLite database", () => {
    const db = new SQLiteDatabase(":memory:")
    db.exec("CREATE TABLE project (id text PRIMARY KEY); CREATE TABLE project_location (id text PRIMARY KEY, project_id text); CREATE TABLE session (id text PRIMARY KEY, project_id text, location_id text);")
    const migration = readFileSync(new URL("../../migration/20260925061154_math_problem_registry/migration.sql", import.meta.url), "utf8")
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement)
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('math_problem','math_problem_worker') ORDER BY name").all()).toHaveLength(2)
    expect(db.query("PRAGMA foreign_key_list(math_problem_worker)").all()).toHaveLength(3)
    db.exec("INSERT INTO project(id) VALUES ('p'); INSERT INTO session(id, project_id) VALUES ('parent','p'),('worker','p'); INSERT INTO math_problem(parent_session_id,problem_id,owner_project_id,orchestrator_session_id,time_created,time_updated) VALUES ('parent','x','p','parent',1,1); INSERT INTO math_problem_worker(parent_session_id,problem_id,worker_session_id) VALUES ('parent','x','worker');")
    expect(() => db.exec("INSERT INTO math_problem_worker(parent_session_id,problem_id,worker_session_id) VALUES ('parent','y','worker')")).toThrow()
    db.close()
  })
})
