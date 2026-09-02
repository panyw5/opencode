import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, ReasoningPart, Session, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { groupParts, reasoningPartStreaming } from "./message-part-order"
import {
  isTaskResume,
  resolveTaskChildSessionId,
  taskElapsedBounds,
  taskElapsedSeconds,
  taskSessionIndex,
  taskSessionNeighbors,
  taskSessionSiblings,
  withTaskSessionIndex,
} from "./message-task-session"
import { skillText } from "./message-skill"
import { activeStreamingAssistantMessageID, hold, streamsplit } from "./message-part-stream"
import { isDismissedQuestion } from "./message-question"

function text(part: Partial<TextPart> = {}): TextPart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text: "value",
    ...part,
  }
}

function reasoning(part: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    id: "part_reasoning",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "reasoning",
    text: "thinking",
    time: { start: 1 },
    ...part,
  }
}

function tool(part: Partial<ToolPart> = {}): ToolPart {
  return {
    id: "part_tool",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    },
    ...part,
  }
}

function session(input: { id: string; parentID?: string; title?: string; agent?: string; created?: number }): Session {
  const created = input.created ?? 1
  return {
    id: input.id,
    slug: input.id,
    projectID: "proj",
    directory: "/repo",
    parentID: input.parentID,
    title: input.title ?? input.id,
    agent: input.agent,
    version: "0.0.0",
    time: { created, updated: created },
  } satisfies Session
}

function assistant(completed?: number): AssistantMessage {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    time: completed === undefined ? { created: 1 } : { created: 1, completed },
    parentID: "msg_user",
    modelID: "model_1",
    providerID: "provider_1",
    agent: "agent_1",
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("message-part groupParts", () => {
  const isContextGroupTool = () => false

  test("renders reasoning before text within the same assistant segment", () => {
    const groups = groupParts(
      [
        { messageID: "msg_1", part: text({ id: "part_text" }) },
        { messageID: "msg_1", part: reasoning({ id: "part_reasoning" }) },
      ],
      isContextGroupTool,
    )

    expect(groups.map((group) => group.key)).toEqual(["part:msg_1:part_reasoning", "part:msg_1:part_text"])
  })

  test("does not move reasoning across tool boundaries", () => {
    const groups = groupParts(
      [
        { messageID: "msg_1", part: text({ id: "part_text" }) },
        { messageID: "msg_1", part: tool({ id: "part_tool" }) },
        { messageID: "msg_1", part: reasoning({ id: "part_reasoning" }) },
      ],
      isContextGroupTool,
    )

    expect(groups.map((group) => group.key)).toEqual([
      "part:msg_1:part_text",
      "part:msg_1:part_tool",
      "part:msg_1:part_reasoning",
    ])
  })

  test("does not move reasoning across message boundaries", () => {
    const groups = groupParts(
      [
        { messageID: "msg_1", part: text({ id: "part_text_1", messageID: "msg_1" }) },
        { messageID: "msg_2", part: reasoning({ id: "part_reasoning_2", messageID: "msg_2" }) },
      ],
      isContextGroupTool,
    )

    expect(groups.map((group) => group.key)).toEqual(["part:msg_1:part_text_1", "part:msg_2:part_reasoning_2"])
  })
})

describe("message-part reasoningPartStreaming", () => {
  test("uses the reasoning part end time before the assistant completion time", () => {
    expect(reasoningPartStreaming(reasoning(), assistant())).toBe(true)
    expect(reasoningPartStreaming(reasoning({ time: { start: 1, end: 2 } }), assistant())).toBe(false)
  })

  test("treats incomplete reasoning as stopped once the assistant completes", () => {
    expect(reasoningPartStreaming(reasoning(), assistant(3))).toBe(false)
  })
})

describe("message-part isDismissedQuestion", () => {
  test("recognizes dismissed question tool errors", () => {
    expect(
      isDismissedQuestion({
        tool: "question",
        state: { status: "error", error: "Error: The user dismissed this question" },
      }),
    ).toBe(true)
  })

  test("does not treat other tool errors as dismissed questions", () => {
    expect(
      isDismissedQuestion({
        tool: "bash",
        state: { status: "error", error: "The user dismissed this question" },
      }),
    ).toBe(false)
    expect(
      isDismissedQuestion({
        tool: "question",
        state: { status: "error", error: "Network unavailable" },
      }),
    ).toBe(false)
  })
})

describe("message-part skillText", () => {
  test("returns synthetic skill template text", () => {
    const parts: Part[] = [
      text({ text: "user input" }),
      text({
        id: "part_2",
        text: "skill template",
        synthetic: true,
        metadata: { kind: "skill-template" },
      }),
    ]

    expect(skillText(parts)?.text).toBe("skill template")
  })

  test("ignores unrelated synthetic text", () => {
    const parts: Part[] = [
      text({
        id: "part_2",
        text: 'Called the Read tool with the following input: {"filePath":"/tmp/x"}',
        synthetic: true,
      }),
    ]

    expect(skillText(parts)).toBeUndefined()
  })
})

describe("message-part resolveTaskChildSessionId", () => {
  test("uses task metadata when present", () => {
    expect(
      resolveTaskChildSessionId({
        metadata: { sessionId: "ses_child" },
        sessions: [],
      }),
    ).toBe("ses_child")
  })

  test("falls back to child session title when task metadata is missing", () => {
    const task = tool({
      tool: "task",
      sessionID: "ses_parent",
      state: {
        status: "running",
        input: { description: "inspect bug", subagent_type: "scout" },
        time: { start: 100 },
      },
    })

    expect(
      resolveTaskChildSessionId({
        tool: task,
        input: task.state.input,
        sessions: [
          session({ id: "ses_other", parentID: "ses_parent", title: "Other", created: 90 }),
          session({ id: "ses_child", parentID: "ses_parent", title: "inspect bug (@scout subagent)", created: 101 }),
        ],
      }),
    ).toBe("ses_child")
  })
})

describe("message-part taskElapsedSeconds", () => {
  test("counts whole seconds while a task is running", () => {
    expect(taskElapsedSeconds({ start: 1_000, now: 7_999 })).toBe(6)
  })

  test("uses the recorded completion time instead of the current time", () => {
    expect(taskElapsedSeconds({ start: 1_000, end: 7_999, now: 60_000 })).toBe(6)
  })

  test("does not render a duration before the task has started", () => {
    expect(taskElapsedSeconds({ now: 7_999 })).toBeUndefined()
  })
})

describe("message-part taskElapsedBounds", () => {
  test("keeps counting while the parent tool is still running", () => {
    expect(
      taskElapsedBounds({
        toolStatus: "running",
        toolStart: 1_000,
      }),
    ).toEqual({ start: 1_000, end: undefined })
  })

  test("uses tool end for normal foreground completions", () => {
    expect(
      taskElapsedBounds({
        toolStatus: "completed",
        toolStart: 1_000,
        toolEnd: 61_000,
      }),
    ).toEqual({ start: 1_000, end: 61_000 })
  })

  test("does not freeze at 0s for background tools that complete immediately", () => {
    // Real session data: background task tool ends ~80ms after start.
    expect(
      taskElapsedBounds({
        toolStatus: "completed",
        toolStart: 1_000,
        toolEnd: 1_083,
        background: true,
        childCreated: 1_000,
        childBusy: true,
      }),
    ).toEqual({ start: 1_000, end: undefined })
  })

  test("settles on child assistant completion for finished background tasks", () => {
    expect(
      taskElapsedBounds({
        toolStatus: "completed",
        toolStart: 1_000,
        toolEnd: 1_083,
        background: true,
        childCreated: 1_000,
        childCompleted: 301_000,
        childBusy: false,
      }),
    ).toEqual({ start: 1_000, end: 301_000 })
  })

  test("falls back to child.updated when messages are unavailable", () => {
    expect(
      taskElapsedBounds({
        toolStatus: "completed",
        toolStart: 1_000,
        toolEnd: 1_083,
        background: true,
        childCreated: 1_000,
        childUpdated: 420_000,
        childBusy: false,
      }),
    ).toEqual({ start: 1_000, end: 420_000 })
  })
})

describe("message-part taskSessionIndex", () => {
  const sessions = [
    session({ id: "ses_a", parentID: "ses_parent", title: "first", created: 10 }),
    session({ id: "ses_b", parentID: "ses_parent", title: "second", created: 20 }),
    session({ id: "ses_other", parentID: "ses_elsewhere", title: "other", created: 15 }),
  ]

  test("numbers child sessions by creation order under the same parent", () => {
    expect(
      taskSessionIndex({
        childSessionId: "ses_a",
        parentSessionId: "ses_parent",
        sessions,
      }),
    ).toBe(1)
    expect(
      taskSessionIndex({
        childSessionId: "ses_b",
        parentSessionId: "ses_parent",
        sessions,
      }),
    ).toBe(2)
  })

  test("keeps the same number for every resume of the same child session", () => {
    const first = taskSessionIndex({
      childSessionId: "ses_b",
      parentSessionId: "ses_parent",
      sessions,
    })
    const resume = taskSessionIndex({
      childSessionId: "ses_b",
      parentSessionId: "ses_parent",
      sessions,
    })
    expect(first).toBe(2)
    expect(resume).toBe(first)
  })

  test("finds adjacent sibling sessions using the canonical creation order", () => {
    const unordered = [
      session({ id: "ses_b", parentID: "ses_parent", title: "second", created: 20 }),
      session({ id: "ses_elsewhere", parentID: "ses_other", title: "other", created: 5 }),
      session({ id: "ses_c", parentID: "ses_parent", title: "third", created: 30 }),
      session({ id: "ses_a", parentID: "ses_parent", title: "first", created: 10 }),
    ]

    expect(taskSessionSiblings({ parentSessionId: "ses_parent", sessions: unordered }).map((item) => item.id)).toEqual([
      "ses_a",
      "ses_b",
      "ses_c",
    ])
    expect(
      taskSessionNeighbors({
        childSessionId: "ses_b",
        parentSessionId: "ses_parent",
        sessions: unordered,
      }),
    ).toMatchObject({ previous: { id: "ses_a" }, next: { id: "ses_c" } })
  })

  test("leaves navigation disabled at sibling boundaries", () => {
    expect(
      taskSessionNeighbors({
        childSessionId: "ses_a",
        parentSessionId: "ses_parent",
        sessions,
      }),
    ).toEqual({ previous: undefined, next: sessions[1] })
    expect(
      taskSessionNeighbors({
        childSessionId: "ses_b",
        parentSessionId: "ses_parent",
        sessions,
      }),
    ).toEqual({ previous: sessions[0], next: undefined })
  })

  test("prefixes agent titles with the stable session index", () => {
    expect(withTaskSessionIndex("Trellis-implement", 1)).toBe("#1 Trellis-implement")
    expect(withTaskSessionIndex("Trellis-implement", 3, { resume: true })).toBe("#3 续跑 Trellis-implement")
    expect(withTaskSessionIndex("Trellis-implement", undefined)).toBe("Trellis-implement")
    expect(isTaskResume({ task_id: "ses_child" })).toBe(true)
    expect(isTaskResume({ description: "fresh" })).toBe(false)
  })
})

describe("message-part streamsplit", () => {
  test("keeps completed paragraphs in the stable head", () => {
    expect(streamsplit("Alpha $$x^2$$\n\nBeta")).toEqual({
      head: "Alpha $$x^2$$",
      tail: "Beta",
    })
  })

  test("keeps completed fenced blocks in the stable head", () => {
    expect(streamsplit("```ts\nconst x = 1\n```\nnext")).toEqual({
      head: "```ts\nconst x = 1\n```",
      tail: "next",
    })
  })

  test("leaves unfinished streaming text in the tail", () => {
    expect(streamsplit("Alpha $$x^2$$")).toEqual({
      head: "",
      tail: "Alpha $$x^2$$",
    })
  })

  test("holds tiny heading markers in the tail", () => {
    expect(hold("Alpha\n\n##")).toEqual({
      head: "",
      tail: "Alpha\n\n##",
    })
  })

  test("holds tiny visible tails until they are substantial", () => {
    expect(hold("Alpha\n\nBeta")).toEqual({
      head: "",
      tail: "Alpha\n\nBeta",
    })
  })

  test("splits again once the tail is substantial", () => {
    expect(hold("Alpha $$x^2$$\n\nBeta with enough text")).toEqual({
      head: "Alpha $$x^2$$",
      tail: "Beta with enough text",
    })
  })
})

describe("message-part activeStreamingAssistantMessageID", () => {
  test("returns only the latest incomplete assistant message", () => {
    expect(
      activeStreamingAssistantMessageID([
        assistant(2),
        { ...assistant(), id: "msg_active_1", time: { created: 3 } },
        { ...assistant(), id: "msg_active_2", time: { created: 4 } },
      ]),
    ).toBe("msg_active_2")
  })

  test("returns undefined when all assistant messages are completed", () => {
    expect(activeStreamingAssistantMessageID([assistant(2), { ...assistant(3), id: "msg_2" }])).toBeUndefined()
  })
})
