import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createSessionModelRestoreQueue, resetSessionModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: Partial<Pick<UserMessage, "agent" | "model">> & { variant?: string }) =>
  ({
    id: "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "build",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4", variant: input?.variant },
  }) as UserMessage

describe("syncSessionModel", () => {
  test("restores the last message through session state", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      message({ variant: "high" }),
    )

    expect(calls).toEqual([
      {
        sessionID: "session",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" },
        variant: "high",
      },
    ])
  })

  test("waits for persisted state before restoring a message model", async () => {
    const calls: UserMessage[] = []
    let release!: () => void
    let ready = false
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const request = createSessionModelRestoreQueue<UserMessage>({
      ready: () => ready,
      wait,
      restore: (value) => calls.push(value),
    })
    const value = message({ variant: "high" })

    request(value)
    expect(calls).toEqual([])

    ready = true
    release()
    await wait
    await Promise.resolve()

    expect(calls).toEqual([value])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})
