import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import {
  buildWorkerKickoff,
  discoverMathWorkers,
  ensureMathWorker,
  latestAcceptedFactId,
  startMathWorker,
  statusMathWorker,
  stopMathWorker,
  workerMcpConfig,
  writeHeartbeat,
} from "@/math/worker"
import { readSwarm, writeSwarm } from "@/math/swarm"
import { mathRoot } from "@/math/layout"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import path from "path"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer))

describe("math.worker", () => {
  it.instance("start records swarm.json without blocking on the child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const test = yield* TestInstance
      const spawned: string[][] = []
      const spawnedEnv: Array<NodeJS.ProcessEnv | undefined> = []
      const result = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "lemma-slice",
        task: "# prove the rank obstruction\n",
        model: "test/prover",
        variant: "xhigh",
        spawn: (input) => {
          spawned.push(input.argv)
          spawnedEnv.push(input.env)
          return { pid: 4242 }
        },
      })
      expect(result.state).toBe("running")
      expect(result.pid).toBe(4242)
      expect(result.sessionID.startsWith("ses")).toBe(true)
      expect(spawned[0]?.join(" ")).toContain("math worker")
      expect(spawned[0]?.join(" ")).toContain(result.sessionID)
      expect(spawned[0]?.join(" ")).toContain("--model test/prover --variant xhigh")
      expect(spawnedEnv[0]?.OPENCODE_CONFIG_CONTENT).toContain('"math-truth"')
      expect(spawnedEnv[0]?.OPENCODE_CONFIG_CONTENT).toContain('"worker"')

      const projectDir = mathRoot(test.directory, path.basename(test.directory) || "default")
      const swarm = readSwarm(projectDir)
      expect(swarm.workers[result.sessionID]?.pid).toBe(4242)
      expect(swarm.workers[result.sessionID]?.parentSessionID).toBe(parent.id)
      expect(swarm.workers[result.sessionID]?.model).toBe("test/prover")
      expect(swarm.workers[result.sessionID]?.variant).toBe("xhigh")

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

  it.instance("worker kickoff carries task and truth contract", () =>
    Effect.gen(function* () {
      const prompt = buildWorkerKickoff({ task: "Prove lemma L", round: 3 })
      expect(prompt).toContain("round 3")
      expect(prompt).toContain("Prove lemma L")
      expect(prompt).toContain("fact_submit")
      const config = JSON.parse(
        workerMcpConfig({ projectDir: "/tmp/math", workspace: "/tmp/work", sessionID: "ses_test" }),
      )
      expect(config.mcp["math-truth"].command.join(" ")).toContain("math mcp --role worker")
      expect(config.mcp["math-truth"].environment.OPENCODE_MATH_WORKSPACE).toBe("/tmp/work")
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

  it.instance("ensure refuses to override a deliberate stop marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const started = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "stopped",
        task: "# Do not restart",
        spawn: () => ({ pid: 454545 }),
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
      expect(readSwarm(started.projectDir).workers[started.sessionID]?.pid).toBe(454545)
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
