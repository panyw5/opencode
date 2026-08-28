import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import {
  buildWorkerKickoff,
  completedWorkerFactId,
  discoverMathWorkers,
  ensureMathWorker,
  latestAcceptedFactId,
  readMathWorkerTask,
  startMathWorker,
  statusMathWorker,
  stopMathWorker,
  updateMathWorkerTask,
  workerMcpConfig,
  writeHeartbeat,
} from "@/math/worker"
import { readSwarm, writeSwarm } from "@/math/swarm"
import { mathRoot } from "@/math/layout"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import path from "path"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer))

describe("math.worker", () => {
  it.instance("start records swarm.json without blocking on the child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const test = yield* TestInstance
      const spawned: string[][] = []
      const spawnedEnv: Array<NodeJS.ProcessEnv | undefined> = []
      const spawnedCwd: string[] = []
      const result = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "lemma-slice",
        task: "# prove the rank obstruction\n",
        model: "test/prover",
        verifierModel: "test/verifier",
        variant: "xhigh",
        spawn: (input) => {
          spawned.push(input.argv)
          spawnedEnv.push(input.env)
          spawnedCwd.push(input.cwd)
          return { pid: 987_654_321 }
        },
      })
      expect(result.state).toBe("running")
      expect(result.pid).toBe(987_654_321)
      expect(result.sessionID.startsWith("ses")).toBe(true)
      expect(spawned[0]?.join(" ")).toContain("math worker")
      expect(spawned[0]?.join(" ")).toContain(result.sessionID)
      expect(spawned[0]?.join(" ")).toContain("--model test/prover --variant xhigh")
      expect(spawnedEnv[0]?.OPENCODE_CONFIG_CONTENT).toContain('"math-truth"')
      expect(spawnedEnv[0]?.OPENCODE_CONFIG_CONTENT).toContain('"worker"')
      expect(spawnedEnv[0]?.OPENCODE_CONFIG_CONTENT).toContain('"OPENCODE_MATH_VERIFY_MODEL":"test/verifier"')

      const projectDir = mathRoot(test.directory, parent.id)
      expect(projectDir).toContain(path.join(".math", "problems"))
      expect(spawnedCwd).toEqual([projectDir])
      expect(spawnedEnv[0]?.OPENCODE_MATH_WORKSPACE).toBe(projectDir)
      const swarm = readSwarm(projectDir)
      expect(swarm.workers[result.sessionID]?.pid).toBe(987_654_321)
      expect(swarm.workers[result.sessionID]?.parentSessionID).toBe(parent.id)
      expect(swarm.workers[result.sessionID]?.model).toBe("test/prover")
      expect(swarm.workers[result.sessionID]?.variant).toBe("xhigh")
      expect(swarm.verifierModel).toBe("test/verifier")

      const rows = statusMathWorker({ projectDir, parentSessionID: parent.id })
      expect(rows.some((r) => r.sessionID === result.sessionID)).toBe(true)

      const stopped = stopMathWorker({ projectDir, sessionID: result.sessionID })
      expect(stopped.state).not.toBe("missing")
    }),
  )

  it.instance("heartbeat appends a synthetic text part", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "hb", agent: "math-worker" })
      const test = yield* TestInstance
      const projectDir = mathRoot(test.directory, path.basename(test.directory) || "default")
      yield* writeHeartbeat({ sessionID: session.id, round: 1, projectDir })
      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(msgs.length).toBeGreaterThan(0)
      const text = msgs.flatMap((m) => m.parts).find((p) => p.type === "text" && "text" in p)
      expect(text && text.type === "text" ? text.text : "").toContain("heartbeat round=1")
    }),
  )

  it.instance("heartbeat preserves stopping state after a stop marker exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "stopping-heartbeat",
        task: "# stop now",
        spawn: () => ({ pid: 987_654_321 }),
      })
      stopMathWorker({ projectDir: started.projectDir, sessionID: started.sessionID })

      yield* writeHeartbeat({ sessionID: SessionID.make(started.sessionID), round: 2, projectDir: started.projectDir })

      expect(readSwarm(started.projectDir).workers[started.sessionID]?.state).toBe("stopping")
    }),
  )

  it.instance("worker kickoff carries task and truth contract", () =>
    Effect.gen(function* () {
      const prompt = buildWorkerKickoff({ task: "Prove lemma L", round: 3 })
      expect(prompt).toContain("round 3")
      expect(prompt).toContain("Prove lemma L")
      expect(prompt).toContain("fact_submit")
      expect(prompt).toContain("MATH_WORKER_TASK_COMPLETE")
      const config = JSON.parse(
        workerMcpConfig({
          projectDir: "/tmp/math",
          workspace: "/tmp/work",
          sessionID: "ses_test",
          verifierModel: "test/verifier",
        }),
      )
      expect(config.mcp["math-truth"].command.join(" ")).toContain("math mcp --role worker")
      expect(config.mcp["math-truth"].environment.OPENCODE_MATH_WORKSPACE).toBe("/tmp/work")
      expect(config.mcp["math-truth"].environment.OPENCODE_MATH_VERIFY_MODEL).toBe("test/verifier")
      expect(config.agent["math-worker"].permission.external_directory).toBe("deny")
    }),
  )

  it.instance("extracts the latest accepted fact id from tool parts", () =>
    Effect.gen(function* () {
      const messages = [
        {
          info: {},
          parts: [
            {
              type: "tool",
              tool: "math-truth_fact_submit",
              state: { status: "completed", output: '{"accepted":true,"fact_id":"abc123"}' },
            },
          ],
        },
      ] as unknown as MessageV2.WithParts[]
      expect(latestAcceptedFactId(messages)).toBe("abc123")
    }),
  )

  it.instance("accepts a worker completion marker only with a verified fact", () =>
    Effect.gen(function* () {
      const message = {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "Proof complete.\nMATH_WORKER_TASK_COMPLETE" }],
      } as unknown as MessageV2.WithParts
      expect(completedWorkerFactId(message, "fact123")).toBe("fact123")
      expect(completedWorkerFactId(message, undefined)).toBeUndefined()

      const partial = {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "MATH_WORKER_TASK_COMPLETE is not justified yet." }],
      } as unknown as MessageV2.WithParts
      expect(completedWorkerFactId(partial, "fact123")).toBeUndefined()
    }),
  )

  it.instance("ensure restarts the same durable session without creating a child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const test = yield* TestInstance
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "restartable",
        task: "# Continue the proof",
        model: "test/original",
        variant: "high",
        spawn: () => ({ pid: 424242 }),
      })
      const before = yield* sessions.children(parent.id)
      let restartArgv: string[] = []
      const ensured = yield* ensureMathWorker({
        sessionID: SessionID.make(started.sessionID),
        projectDir: started.projectDir,
        spawn: (input) => {
          restartArgv = input.argv
          return { pid: 525252 }
        },
      })
      const after = yield* sessions.children(parent.id)
      expect(ensured.restarted).toBe(true)
      expect(ensured.sessionID).toBe(started.sessionID)
      expect(ensured.previousPid).toBe(424242)
      expect(ensured.pid).toBe(525252)
      expect(restartArgv.join(" ")).toContain("--model test/original --variant high")
      expect(after.map((child) => child.id)).toEqual(before.map((child) => child.id))
      expect(readSwarm(started.projectDir).workers[started.sessionID]?.pid).toBe(525252)
      expect(readSwarm(started.projectDir).workers[started.sessionID]?.model).toBe("test/original")
      expect(test.directory).toBeTruthy()
    }),
  )

  it.instance("discover reconnects durable children when swarm roster is missing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "discoverable",
        task: "# Durable task",
        spawn: () => ({ pid: 434343 }),
      })
      writeSwarm(started.projectDir, { projectDir: started.projectDir, workers: {} })
      const rows = yield* discoverMathWorkers({ projectDir: started.projectDir, parentSessionID: parent.id })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.sessionID).toBe(started.sessionID)
      expect(rows[0]?.state).toBe("missing")
      expect(rows[0]?.attachable).toBe(true)
      expect(rows[0]?.restartable).toBe(true)
    }),
  )

  it.instance("discover finalizes an incomplete assistant when the detached worker is dead", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "dead-worker",
        task: "# Continue until stopped",
        spawn: () => ({ pid: 987_654_321 }),
      })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: SessionID.make(started.sessionID),
        role: "user",
        time: { created: Date.now() },
        agent: "math-worker",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: SessionID.make(started.sessionID),
        parentID: user.id,
        role: "assistant",
        mode: "math-worker",
        agent: "math-worker",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        time: { created: Date.now() },
      } satisfies MessageV2.Assistant)

      const rows = yield* discoverMathWorkers({ projectDir: started.projectDir, parentSessionID: parent.id })
      expect(rows[0]).toMatchObject({ sessionID: started.sessionID, alive: false, state: "dead" })

      const messages = yield* sessions.messages({ sessionID: SessionID.make(started.sessionID) })
      const finalized = messages.find((message) => message.info.id === assistant.id)
      expect(finalized?.info.role).toBe("assistant")
      if (!finalized || finalized.info.role !== "assistant") return
      expect(finalized.info.time.completed).toBeNumber()
      expect(finalized.info.error?.name).toBe("MessageAbortedError")

      yield* discoverMathWorkers({ projectDir: started.projectDir, parentSessionID: parent.id })
      const afterRefresh = yield* sessions.messages({ sessionID: SessionID.make(started.sessionID) })
      const unchanged = afterRefresh.find((message) => message.info.id === assistant.id)
      expect(unchanged?.info.time.completed).toBe(finalized.info.time.completed)
    }),
  )

  it.instance("ensure refuses to override a deliberate stop marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "stopped",
        task: "# Do not restart",
        spawn: () => ({ pid: 987_654_321 }),
      })
      stopMathWorker({ projectDir: started.projectDir, sessionID: started.sessionID })
      const exit = yield* Effect.exit(
        ensureMathWorker({
          sessionID: SessionID.make(started.sessionID),
          projectDir: started.projectDir,
          spawn: () => ({ pid: 565656 }),
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(readSwarm(started.projectDir).workers[started.sessionID]?.pid).toBe(987_654_321)
    }),
  )

  it.instance("explicit re-enable clears the stop marker and restarts the durable dead worker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "re-enable",
        task: "# Resume this task",
        spawn: () => ({ pid: 987_654_321 }),
      })
      stopMathWorker({ projectDir: started.projectDir, sessionID: started.sessionID })
      expect(statusMathWorker({ projectDir: started.projectDir })[0]?.stopRequested).toBe(true)

      const ensured = yield* ensureMathWorker({
        sessionID: SessionID.make(started.sessionID),
        projectDir: started.projectDir,
        reEnable: true,
        spawn: () => ({ pid: 575757 }),
      })

      expect(ensured.restarted).toBe(true)
      expect(ensured.pid).toBe(575757)
      expect(statusMathWorker({ projectDir: started.projectDir })[0]?.stopRequested).toBe(false)
    }),
  )

  it.instance("reads and atomically updates the next-round TASK", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "task-edit",
        task: "# Original direction",
        spawn: () => ({ pid: 585858 }),
      })
      expect(readMathWorkerTask(started.projectDir, started.sessionID).task).toContain("Original direction")

      const updated = updateMathWorkerTask(started.projectDir, started.sessionID, "# New direction\nProve lemma B.")
      expect(updated.task).toBe("# New direction\nProve lemma B.\n")
      expect(statusMathWorker({ projectDir: started.projectDir })[0]).toMatchObject({
        taskPreview: "# New direction Prove lemma B.",
      })
      expect(() => updateMathWorkerTask(started.projectDir, started.sessionID, "   ")).toThrow(
        "TASK cannot be empty",
      )
    }),
  )
})

describe("math.agents", () => {
  it.instance("math-worker cannot nest task or run bash; orchestrator can start workers", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const worker = yield* agents.get("math-worker")
      const orch = yield* agents.get("math-orchestrator")
      const verifier = yield* agents.get("math-verifier")
      expect(worker.mode).toBe("subagent")
      expect(orch.mode).toBe("primary")
      expect(orch.hidden).toBe(true)
      expect(verifier.mode).toBe("subagent")
      expect(Permission.evaluate("*", "*", verifier.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", verifier.permission).action).toBe("deny")
      expect(Permission.evaluate("fact_submit", "*", verifier.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "*", worker.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", worker.permission).action).toBe("deny")
      expect(Permission.evaluate("math_worker_start", "*", worker.permission).action).toBe("deny")
      expect(Permission.evaluate("math-truth_fact_submit", "*", worker.permission).action).toBe("allow")
      expect(Permission.evaluate("math-truth_fact_get", "*", worker.permission).action).toBe("allow")
      expect(Permission.evaluate("math_worker_start", "*", orch.permission).action).toBe("allow")
      expect(Permission.evaluate("math_worker_ensure", "*", orch.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "*", orch.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "*", orch.permission).action).toBe("allow")
      expect(orch.prompt).toContain("same session ID")
      const build = yield* agents.get("build")
      expect(Permission.evaluate("math_worker_start", "*", build.permission).action).toBe("deny")
      expect(Permission.evaluate("skill", "verify-proof", build.permission).action).toBe("deny")
      expect(Permission.evaluate("skill", "verify-proof", orch.permission).action).toBe("deny")
      expect(Permission.evaluate("skill", "verify-proof", worker.permission).action).toBe("allow")
    }),
  )
})
