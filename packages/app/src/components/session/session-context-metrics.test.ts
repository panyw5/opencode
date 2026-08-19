import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { getSessionContextMetrics } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number; total?: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      total: tokens.total,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContextMetrics", () => {
  test("computes totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.totalCost).toBe(1.75)
    expect(metrics.context?.message?.id).toBe("a2")
    expect(metrics.context?.total).toBe(500)
    expect(metrics.context?.usage).toBe(50)
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("skips trailing in-progress or aborted assistants with zero tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 245784, output: 116, reasoning: 0, read: 0, write: 0, total: 245900 }, 0, "axonhub", "glm-5.2"),
      assistant("a2", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0, "axonhub", "glm-5.2"),
    ]
    const providers = [
      {
        id: "axonhub",
        name: "AxonHub",
        models: {
          "glm-5.2": {
            name: "glm-5.2",
            limit: { context: 1_000_000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.message?.id).toBe("a1")
    expect(metrics.context?.total).toBe(245900)
    expect(metrics.context?.input).toBe(245784)
    expect(metrics.context?.output).toBe(116)
    expect(metrics.context?.usage).toBe(25)
  })

  test("prefers reported tokens.total over summed components", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 0, read: 0, write: 0, total: 1000 }, 0)]
    const providers = [{ id: "openai", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.total).toBe(1000)
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message?.id).toBe("a1")
    expect(two.context?.message?.id).toBe("a2")
    expect(two.totalCost).toBe(1)
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.totalCost).toBe(0)
    expect(metrics.context).toBeUndefined()
  })

  test("falls back to session model and referenced limit when tokens are missing", () => {
    const messages = [user("u1"), assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0, "axonhub", "deepseek-v4-flash-0731")]
    const providers = [
      {
        id: "axonhub",
        name: "AxonHub",
        models: {
          "deepseek-v4-flash-0731": {
            name: "deepseek-v4-flash-0731",
            limit: { context: 0 },
          },
        },
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        models: {
          "deepseek/deepseek-v4-flash-0731": {
            name: "DeepSeek V4 Flash 0731",
            limit: { context: 1_310_720 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("AxonHub")
    expect(metrics.context?.modelLabel).toBe("deepseek-v4-flash-0731")
    expect(metrics.context?.limit).toBe(1_310_720)
    expect(metrics.context?.limitSource).toBe("openrouter")
    expect(metrics.context?.usage).toBe(0)
  })
})
