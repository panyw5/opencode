import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { mathRoot } from "@/math/layout"
import { writeProblemStatement } from "@/math/problem"
import { readMathWorkerTask, startMathWorker } from "@/math/worker"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { MathWorkerTaskUpdateTool } from "@/tool/math-worker"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, Session.defaultLayer, Bus.layer))

afterEach(async () => {
  await disposeAllInstances()
})

function context(sessionID: Tool.Context["sessionID"], ask: Tool.Context["ask"]): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "math-orchestrator",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask,
  }
}

describe("tool.math_worker_task_update", () => {
  it.instance("atomically revises a durable child worker TASK", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Math", agent: "math-orchestrator" })
      const project = "task-update"
      const projectDir = mathRoot(parent.directory, project)
      writeProblemStatement(
        projectDir,
        `Prove the specified theorem. ${"Every definition and convention is fixed. ".repeat(8)}`,
      )
      const worker = yield* startMathWorker({
        parentSessionID: parent.id,
        project,
        title: "Bridge lemma",
        task: "Prove the first bridge lemma.",
        spawn: () => ({ pid: 987_654_321 }),
      })
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const info = yield* MathWorkerTaskUpdateTool
      const tool = yield* info.init()
      const result = yield* tool.execute(
        {
          session_id: worker.sessionID,
          project,
          task: "Prove the revised bridge lemma using verified predecessor abc123.",
        },
        context(parent.id, (request) =>
          Effect.sync(() => {
            requests.push(request)
          }),
        ),
      )

      expect(requests[0]?.permission).toBe("math_worker_task_update")
      expect(requests[0]?.patterns).toEqual([worker.sessionID])
      expect(readMathWorkerTask(projectDir, worker.sessionID).task).toBe(
        "Prove the revised bridge lemma using verified predecessor abc123.\n",
      )
      expect(JSON.parse(result.output).sessionID).toBe(worker.sessionID)
    }),
  )

  it.instance("rejects a worker owned by another parent session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const owner = yield* sessions.create({ title: "Owner", agent: "math-orchestrator" })
      const outsider = yield* sessions.create({ title: "Outsider", agent: "math-orchestrator" })
      const project = "ownership"
      writeProblemStatement(
        mathRoot(owner.directory, project),
        `Prove the specified theorem. ${"Every definition and convention is fixed. ".repeat(8)}`,
      )
      const worker = yield* startMathWorker({
        parentSessionID: owner.id,
        project,
        title: "Owned lane",
        task: "Prove the owned lemma.",
        spawn: () => ({ pid: 987_654_322 }),
      })
      const info = yield* MathWorkerTaskUpdateTool
      const tool = yield* info.init()
      const result = yield* tool
        .execute(
          { session_id: worker.sessionID, project, task: "Replace another parent's task." },
          context(outsider.id, () => Effect.void),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(readMathWorkerTask(mathRoot(owner.directory, project), worker.sessionID).task).toBe(
        "Prove the owned lemma.\n",
      )
    }),
  )
})
