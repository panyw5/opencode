import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { startMathWorker, statusMathWorker, stopMathWorker, writeHeartbeat } from "@/math/worker"
import { readSwarm } from "@/math/swarm"
import { mathRoot } from "@/math/layout"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import path from "path"

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer))

describe("math.worker", () => {
  it.instance("start records swarm.json without blocking on the child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "orch", agent: "math-orchestrator" })
      const test = yield* TestInstance
      const spawned: string[][] = []
      const result = yield* startMathWorker({
        parentSessionID: parent.id,
        title: "lemma-slice",
        task: "# prove the rank obstruction\n",
        spawn: (input) => {
          spawned.push(input.argv)
          return { pid: 4242 }
        },
      })
      expect(result.state).toBe("running")
      expect(result.pid).toBe(4242)
      expect(result.sessionID.startsWith("ses")).toBe(true)
      expect(spawned[0]?.join(" ")).toContain("math worker")
      expect(spawned[0]?.join(" ")).toContain(result.sessionID)

      const projectDir = mathRoot(test.directory, path.basename(test.directory) || "default")
      const swarm = readSwarm(projectDir)
      expect(swarm.workers[result.sessionID]?.pid).toBe(4242)
      expect(swarm.workers[result.sessionID]?.parentSessionID).toBe(parent.id)

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
})

describe("math.agents", () => {
  it.instance("math-worker cannot nest task or run bash; orchestrator can start workers", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const worker = yield* agents.get("math-worker")
      const orch = yield* agents.get("math-orchestrator")
      expect(worker.mode).toBe("subagent")
      expect(orch.mode).toBe("primary")
      expect(Permission.evaluate("task", "*", worker.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", worker.permission).action).toBe("deny")
      expect(Permission.evaluate("math_worker_start", "*", worker.permission).action).toBe("deny")
      expect(Permission.evaluate("math_worker_start", "*", orch.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "*", orch.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "*", orch.permission).action).toBe("allow")
      const build = yield* agents.get("build")
      expect(Permission.evaluate("math_worker_start", "*", build.permission).action).toBe("deny")
    }),
  )
})
