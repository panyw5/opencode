import { afterEach, describe, expect } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Server } from "@/server/server"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { layout, mathRoot, taskPath } from "@/math/layout"
import { writeSwarm } from "@/math/swarm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const it = testEffect(
  Layer.mergeAll(instanceStoreLayer, Project.defaultLayer, Session.defaultLayer, InstanceBootstrap.defaultLayer),
)

function endpoint(template: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), template)
}

async function body<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Math worker HttpApi", () => {
  it.instance(
    "reconciles, ensures, and stops durable workers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "math", agent: "math-orchestrator" })
        const worker = yield* sessions.create({ title: "lemma", agent: "math-worker", parentID: parent.id })
        const projectDir = mathRoot(test.directory, "custom-swarm")
        yield* Effect.promise(() => mkdir(layout(projectDir).tasks, { recursive: true }))
        yield* Effect.promise(() => writeFile(taskPath(projectDir, worker.id), "# lemma\n", "utf8"))
        writeSwarm(projectDir, {
          projectDir,
          parentSessionID: parent.id,
          workers: {
            [worker.id]: {
              sessionID: worker.id,
              parentSessionID: parent.id,
              pid: process.pid,
              state: "running",
              startedAt: Date.now(),
              logFile: path.join(layout(projectDir).logs, `worker-${worker.id}.log`),
              taskFile: taskPath(projectDir, worker.id),
              round: 4,
              lastFactId: "fact123",
              model: "test/prover",
              variant: "xhigh",
            },
          },
        })

        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const listResponse = yield* Effect.promise(() =>
          Server.Default().app.request(endpoint(SessionPaths.mathWorkers, { sessionID: parent.id }), { headers }),
        )
        const workers = yield* Effect.promise(() =>
          body<Array<{ sessionID: string; project?: string; round?: number; last_fact_id?: string; variant?: string }>>(
            listResponse,
          ),
        )
        expect(workers).toEqual([
          expect.objectContaining({
            sessionID: worker.id,
            project: "custom-swarm",
            round: 4,
            last_fact_id: "fact123",
            variant: "xhigh",
          }),
        ])

        const invalidProject = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathWorkers, { sessionID: parent.id })}?project=invalid%20name`,
            { headers },
          ),
        )
        expect(invalidProject.status).toBe(400)

        const otherParent = yield* sessions.create({ title: "other", agent: "math-orchestrator" })
        const wrongParent = yield* Effect.promise(() =>
          Server.Default().app.request(
            endpoint(SessionPaths.mathWorkerEnsure, { sessionID: otherParent.id, workerID: worker.id }),
            { headers, method: "POST", body: "{}" },
          ),
        )
        expect(wrongParent.status).toBe(400)

        const duplicateDir = mathRoot(test.directory, "duplicate-swarm")
        yield* Effect.promise(() => mkdir(layout(duplicateDir).tasks, { recursive: true }))
        yield* Effect.promise(() => writeFile(taskPath(duplicateDir, worker.id), "# duplicate\n", "utf8"))
        writeSwarm(duplicateDir, {
          projectDir: duplicateDir,
          parentSessionID: parent.id,
          workers: {
            [worker.id]: {
              sessionID: worker.id,
              parentSessionID: parent.id,
              pid: process.pid,
              state: "running",
              startedAt: Date.now(),
              logFile: path.join(layout(duplicateDir).logs, `worker-${worker.id}.log`),
              taskFile: taskPath(duplicateDir, worker.id),
              round: 1,
            },
          },
        })
        const ambiguous = yield* Effect.promise(() =>
          Server.Default().app.request(
            endpoint(SessionPaths.mathWorkerEnsure, { sessionID: parent.id, workerID: worker.id }),
            { headers, method: "POST", body: "{}" },
          ),
        )
        expect(ambiguous.status).toBe(400)

        const ensureResponse = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathWorkerEnsure, { sessionID: parent.id, workerID: worker.id })}?project=custom-swarm`,
            { headers, method: "POST", body: "{}" },
          ),
        )
        expect(yield* Effect.promise(() => body(ensureResponse))).toMatchObject({ sessionID: worker.id, alive: true })

        const stopResponse = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathWorkerStop, { sessionID: parent.id, workerID: worker.id })}?project=custom-swarm`,
            { headers, method: "POST", body: JSON.stringify({ force: false }) },
          ),
        )
        expect(yield* Effect.promise(() => body(stopResponse))).toMatchObject({
          sessionID: worker.id,
          state: "stopping",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
