import { afterEach, describe, expect } from "bun:test"
import { spawnSync } from "node:child_process"
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
import { SessionInput } from "@/session/input"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { layout, mathRoot, taskPath } from "@/math/layout"
import { killProcessGroup, pidAlive, spawnDetached } from "@/math/spawn"
import { readSwarm, writeSwarm } from "@/math/swarm"
import { FactGraph } from "@/math/fact-graph"
import { GlobalMemory } from "@/math/global-memory"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    SessionInput.defaultLayer,
    InstanceBootstrap.defaultLayer,
  ),
)

function endpoint(template: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), template)
}

async function body<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<T>
}

function processStopped(pid: number) {
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" })
  const state = (ps.stdout ?? "").trim()
  return ps.status !== 0 || state === "" || state.startsWith("Z")
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Math worker HttpApi", () => {
  it.instance(
    "idempotently admits a detached worker event for the parent",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const inbox = yield* SessionInput.Service
        const parent = yield* sessions.create({ title: "math", agent: "math-orchestrator", archived: true })
        const worker = yield* sessions.create({ title: "lemma", agent: "math-worker", parentID: parent.id })
        writeSwarm(test.directory, {
          projectDir: test.directory,
          parentSessionID: parent.id,
          workers: {
            [worker.id]: {
              sessionID: worker.id,
              parentSessionID: parent.id,
              pid: 987_654_321,
              state: "blocked",
              startedAt: Date.now(),
              logFile: path.join(test.directory, "worker.log"),
              generation: 2,
              taskFingerprint: "task-v2",
            },
          },
        })
        const url = endpoint(SessionPaths.mathWorkerEvent, { sessionID: parent.id, workerID: worker.id })
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const payload = JSON.stringify({
          eventID: "blocked_3_verifier",
          kind: "blocked",
          round: 3,
          reason: "verifier-error-streak:3",
          summary: "Verifier failed three times.",
          generation: 2,
          taskFingerprint: "task-v2",
        })

        const first = yield* Effect.promise(() =>
          Server.Default().app.request(url, { method: "POST", headers, body: payload }),
        )
        const second = yield* Effect.promise(() =>
          Server.Default().app.request(url, { method: "POST", headers, body: payload }),
        )
        expect(first.status).toBe(204)
        expect(second.status).toBe(204)
        yield* Effect.sleep("50 millis")
        expect((yield* inbox.cursor(parent.id)).nextAdmittedSeq).toBe(1)

        const stale = yield* Effect.promise(() =>
          Server.Default().app.request(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              eventID: "completed_old",
              kind: "completed",
              round: 1,
              factID: "old-fact",
              summary: "Late result from an old worker process.",
              generation: 1,
              taskFingerprint: "task-v1",
            }),
          }),
        )
        expect(stale.status).toBe(204)
        expect((yield* inbox.cursor(parent.id)).nextAdmittedSeq).toBe(1)
      }),
    30_000,
  )

  it.instance(
    "lists Math Mode fact and verification details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const store = yield* InstanceStore.Service
        const parent = yield* sessions.create({ title: "math", agent: "math-orchestrator" })
        const historicalParent = yield* sessions.create({ title: "older math", agent: "math-orchestrator" })
        const projectDir = mathRoot(test.directory, "detail-swarm")
        const worker = yield* store.provide(
          { directory: projectDir },
          sessions.create({ title: "lemma", agent: "math-worker", parentID: parent.id }),
        )
        const historicalWorker = yield* store.provide(
          { directory: projectDir },
          sessions.create({
            title: "older lemma",
            agent: "math-worker",
            parentID: historicalParent.id,
          }),
        )
        const facts = new FactGraph(projectDir)
        const factId = yield* Effect.promise(() =>
          facts.add({
            problem_id: "P",
            author: worker.id,
            statement: "A holds",
            proof: "Proof of A",
          }),
        )
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: historicalWorker.id,
          role: "user",
          time: { created: Date.now() },
          agent: "math-worker",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: historicalWorker.id,
          parentID: user.id,
          role: "assistant",
          mode: "math-worker",
          agent: "math-worker",
          path: { cwd: projectDir, root: projectDir },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
        } satisfies MessageV2.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: historicalWorker.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_wrong_proof",
          tool: "math-truth_fact_submit",
          state: {
            status: "completed",
            input: { statement: "B holds", proof: "Attempted proof of B" },
            output: JSON.stringify({ accepted: false, verdict: "wrong" }),
            title: "fact_submit",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        yield* Effect.promise(() =>
          new GlobalMemory(projectDir).append({
            kind: "verification",
            claim: "B holds",
            evidence: "gap in step 2",
            author: historicalWorker.id,
            verifiable: false,
            extra: {
              verdict: "wrong",
              verification_report: {
                summary: "Rejected",
                critical_errors: ["Unsupported step"],
                gaps: ["Prove step 2"],
              },
            },
          }),
        )

        const headers = { "x-opencode-directory": test.directory }
        const factsResponse = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathDetails, { sessionID: parent.id })}?project=detail-swarm&kind=facts`,
            { headers },
          ),
        )
        expect(yield* Effect.promise(() => body(factsResponse))).toMatchObject({
          kind: "facts",
          total: 1,
          items: [{ kind: "fact", factId, statement: "A holds", proof: "Proof of A" }],
        })

        const wrongResponse = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathDetails, { sessionID: parent.id })}?project=detail-swarm&kind=wrong`,
            { headers },
          ),
        )
        expect(yield* Effect.promise(() => body(wrongResponse))).toMatchObject({
          kind: "wrong",
          total: 1,
          items: [
            {
              kind: "wrong",
              workerSessionID: historicalWorker.id,
              statement: "B holds",
              proof: "Attempted proof of B",
              report: { summary: "Rejected", criticalErrors: ["Unsupported step"], gaps: ["Prove step 2"] },
            },
          ],
        })

        const legacyDir = path.join(test.directory, ".math", "legacy-swarm")
        const legacyFactId = yield* Effect.promise(() =>
          new FactGraph(legacyDir).add({
            problem_id: "legacy",
            author: worker.id,
            statement: "Legacy fact",
            proof: "Legacy proof",
          }),
        )
        const legacyResponse = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathDetails, { sessionID: parent.id })}?project=legacy-swarm&kind=facts`,
            { headers },
          ),
        )
        expect(yield* Effect.promise(() => body(legacyResponse))).toMatchObject({
          kind: "facts",
          total: 1,
          items: [{ factId: legacyFactId, statement: "Legacy fact", proof: "Legacy proof" }],
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "finalizes an orphaned assistant while listing a dead detached worker",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "math", agent: "math-orchestrator" })
        const worker = yield* sessions.create({ title: "dead lemma", agent: "math-worker", parentID: parent.id })
        const projectDir = mathRoot(test.directory, "dead-swarm")
        yield* Effect.promise(() => mkdir(layout(projectDir).tasks, { recursive: true }))
        yield* Effect.promise(() => writeFile(taskPath(projectDir, worker.id), "# dead lemma\n", "utf8"))
        writeSwarm(projectDir, {
          projectDir,
          parentSessionID: parent.id,
          workers: {
            [worker.id]: {
              sessionID: worker.id,
              parentSessionID: parent.id,
              pid: 987_654_321,
              state: "running",
              startedAt: Date.now(),
              logFile: path.join(layout(projectDir).logs, `worker-${worker.id}.log`),
              taskFile: taskPath(projectDir, worker.id),
              round: 2,
            },
          },
        })
        const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: worker.id,
          role: "user",
          time: { created: Date.now() },
          agent: "math-worker",
          model,
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: worker.id,
          parentID: user.id,
          role: "assistant",
          mode: "math-worker",
          agent: "math-worker",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
          time: { created: Date.now() },
        } satisfies MessageV2.Assistant)

        const response = yield* Effect.promise(() =>
          Server.Default().app.request(endpoint(SessionPaths.mathWorkers, { sessionID: parent.id }), {
            headers: { "x-opencode-directory": test.directory },
          }),
        )
        expect(yield* Effect.promise(() => body(response))).toEqual([
          expect.objectContaining({ sessionID: worker.id, alive: false, state: "dead" }),
        ])

        const messages = yield* sessions.messages({ sessionID: worker.id })
        const finalized = messages.find((message) => message.info.id === assistant.id)
        expect(finalized?.info.role).toBe("assistant")
        if (!finalized || finalized.info.role !== "assistant") return
        expect(finalized.info.time.completed).toBeNumber()
        expect(finalized.info.error?.name).toBe("MessageAbortedError")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

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
        const process = spawnDetached({
          argv: ["/bin/sleep", "30"],
          cwd: test.directory,
          logFile: path.join(layout(projectDir).logs, "http-stop-signal.log"),
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!pidAlive(process.pid)) return
            try {
              killProcessGroup(process.pid, "SIGKILL")
            } catch {
              // The stop endpoint may have reaped the process between the liveness check and cleanup.
            }
          }),
        )
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
          body<
            Array<{
              sessionID: string
              project?: string
              round?: number
              last_fact_id?: string
              variant?: string
              taskPreview?: string
              factCount?: number
            }>
          >(listResponse),
        )
        expect(workers).toEqual([
          expect.objectContaining({
            sessionID: worker.id,
            project: "custom-swarm",
            round: 4,
            last_fact_id: "fact123",
            variant: "xhigh",
            taskPreview: "# lemma",
            factCount: 0,
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
            { headers, method: "POST", body: JSON.stringify({ verifierModel: "test/verifier" }) },
          ),
        )
        expect(yield* Effect.promise(() => body(ensureResponse))).toMatchObject({
          sessionID: worker.id,
          alive: true,
          verifierModel: "test/verifier",
        })
        expect(readSwarm(projectDir).verifierModel).toBe("test/verifier")

        const taskGetResponse = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathWorkerTask, { sessionID: parent.id, workerID: worker.id })}?project=custom-swarm`,
            { headers },
          ),
        )
        expect(yield* Effect.promise(() => body(taskGetResponse))).toMatchObject({
          sessionID: worker.id,
          project: "custom-swarm",
          task: "# lemma\n",
        })

        const taskUpdateResponse = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathWorkerTask, { sessionID: parent.id, workerID: worker.id })}?project=custom-swarm`,
            { headers, method: "PUT", body: JSON.stringify({ task: "# redirected\nProve lemma B." }) },
          ),
        )
        expect(yield* Effect.promise(() => body(taskUpdateResponse))).toMatchObject({
          sessionID: worker.id,
          task: "# redirected\nProve lemma B.\n",
        })

        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: worker.id,
          role: "user",
          time: { created: Date.now() },
          agent: "math-worker",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: worker.id,
          parentID: user.id,
          role: "assistant",
          mode: "math-worker",
          agent: "math-worker",
          path: { cwd: test.directory, root: test.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now() },
        } satisfies MessageV2.Assistant)

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
        const stoppedMessages = yield* sessions.messages({ sessionID: worker.id })
        const stoppedAssistant = stoppedMessages.findLast((message) => message.info.role === "assistant")
        expect(stoppedAssistant?.info.role).toBe("assistant")
        if (stoppedAssistant?.info.role === "assistant") {
          expect(stoppedAssistant.info.time.completed).toBeNumber()
          expect(stoppedAssistant.info.error?.name).toBe("MessageAbortedError")
        }
        yield* pollWithTimeout(
          Effect.sync(() => (processStopped(process.pid) ? true : undefined)),
          "stop endpoint did not terminate the detached worker process group",
          "3 seconds",
        )

        const blockedEnsure = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathWorkerEnsure, { sessionID: parent.id, workerID: worker.id })}?project=custom-swarm`,
            { headers, method: "POST", body: "{}" },
          ),
        )
        expect(blockedEnsure.status).toBe(400)

        const earlyReEnable = yield* Effect.promise(() =>
          Server.Default().app.request(
            `${endpoint(SessionPaths.mathWorkerEnsure, { sessionID: parent.id, workerID: worker.id })}?project=custom-swarm`,
            { headers, method: "POST", body: JSON.stringify({ reEnable: true }) },
          ),
        )
        expect(earlyReEnable.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
