import { describe, expect, test } from "bun:test"
import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2/client"
import { collectSessionChildAgentEntries } from "./session-child-agents"

const session = (input: { id: string; parentID?: string; title?: string; agent?: string; created: number }) =>
  ({
    id: input.id,
    slug: input.id,
    projectID: "proj",
    directory: "/repo",
    parentID: input.parentID,
    title: input.title ?? input.id,
    agent: input.agent,
    version: "0.0.0",
    time: { created: input.created, updated: input.created },
  }) as Session

const assistant = (input: {
  id: string
  sessionID: string
  created: number
  completed?: number | false
  error?: { name: string; data?: { message?: string } }
}) => {
  const time =
    input.completed === false
      ? { created: input.created }
      : { created: input.created, completed: input.completed ?? input.created + 1 }

  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    parentID: "msg_user",
    time,
    agent: "build",
    model: { providerID: "test", modelID: "model" },
    error: input.error,
  } as unknown as Message
}

const task = (input: {
  id: string
  sessionID: string
  messageID: string
  childID: string
  description: string
  agent: string
  started: number
  background?: boolean
  taskID?: string
  callID?: string
}) =>
  ({
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: input.callID ?? input.id,
    tool: "task",
    state: {
      status: "completed",
      input: {
        description: input.description,
        subagent_type: input.agent,
        ...(input.taskID ? { task_id: input.taskID } : {}),
      },
      output: "",
      title: input.description,
      metadata: {
        sessionId: input.childID,
        ...(input.background ? { background: true } : {}),
      },
      time: { start: input.started, end: input.started + 1 },
    },
  }) satisfies ToolPart

describe("collectSessionChildAgentEntries", () => {
  test("collects task tool child sessions in chronological order", () => {
    const messages = [
      assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 }),
      assistant({ id: "msg_2", sessionID: "ses_parent", created: 20 }),
    ]
    const parts: Record<string, Part[]> = {
      msg_1: [
        task({
          id: "prt_late",
          sessionID: "ses_parent",
          messageID: "msg_1",
          childID: "ses_late",
          description: "late task",
          agent: "scout",
          started: 200,
        }),
      ],
      msg_2: [
        task({
          id: "prt_early",
          sessionID: "ses_parent",
          messageID: "msg_2",
          childID: "ses_early",
          description: "early task",
          agent: "general",
          started: 100,
        }),
      ],
    }

    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages,
      parts,
      sessions: [
        session({ id: "ses_late", parentID: "ses_parent", title: "Late child", created: 200 }),
        session({ id: "ses_early", parentID: "ses_parent", title: "Early child", created: 100 }),
      ],
    })

    expect(entries.map((entry) => entry.sessionID)).toEqual(["ses_early", "ses_late"])
    expect(entries.map((entry) => entry.title)).toEqual(["Early child", "Late child"])
    expect(entries.map((entry) => entry.index)).toEqual([1, 2])
    expect(entries.map((entry) => entry.resume)).toEqual([false, false])
  })

  test("adds direct child sessions that are not present in loaded tool parts", () => {
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [],
      parts: {},
      sessions: [
        session({ id: "ses_child", parentID: "ses_parent", title: "Only child", agent: "general", created: 50 }),
      ],
    })

    expect(entries).toEqual([
      {
        id: "session:ses_child",
        sessionID: "ses_child",
        title: "Only child",
        agent: "general",
        created: 50,
        usage: "not used",
        index: 1,
        resume: false,
      },
    ])
  })

  test("does not duplicate a direct child session already represented by a task tool", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "inspect bug",
            agent: "general",
            started: 25,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Inspect bug", created: 25 })],
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe("tool:msg_1:prt_1:ses_child")
    expect(entries[0]?.status).toBe("completed")
    expect(entries[0]?.usage).toBeUndefined()
    expect(entries[0]?.title).toBe("Inspect bug")
    expect(entries[0]?.index).toBe(1)
    expect(entries[0]?.resume).toBe(false)
  })

  test("deduplicates replayed task parts with the same callID", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_original",
            callID: "call_task",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "inspect bug",
            agent: "general",
            started: 25,
          }),
          task({
            id: "prt_replay",
            callID: "call_task",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "inspect bug",
            agent: "general",
            started: 26,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Inspect bug", created: 25 })],
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe("tool:msg_1:prt_original:ses_child")
    expect(entries[0]?.resume).toBe(false)
  })

  test("marks resumed task calls with the same session index and resume flag", () => {
    const messages = [
      assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 }),
      assistant({ id: "msg_2", sessionID: "ses_parent", created: 20 }),
    ]
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages,
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "计算 flavored 指标",
            agent: "trellis-implement",
            started: 25,
          }),
        ],
        msg_2: [
          task({
            id: "prt_2",
            sessionID: "ses_parent",
            messageID: "msg_2",
            childID: "ses_child",
            description: "继续 flavored 计算",
            agent: "trellis-implement",
            started: 40,
            taskID: "ses_child",
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "计算 flavored 指标", created: 25 })],
    })

    // Titles stay plain; UI renders "#n" / "#n 续跑" from index + resume.
    expect(entries.map((entry) => entry.title)).toEqual(["计算 flavored 指标", "计算 flavored 指标"])
    expect(entries.map((entry) => entry.resume)).toEqual([false, true])
    expect(entries.map((entry) => entry.index)).toEqual([1, 1])
  })

  test("uses the task description as the title when the child session is not loaded", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "inspect bug",
            agent: "Coder - Implementation Agent",
            started: 25,
          }),
        ],
      },
      sessions: [],
    })

    expect(entries[0]?.title).toBe("inspect bug")
    expect(entries[0]?.agent).toBe("Coder - Implementation Agent")
    expect(entries[0]?.status).toBe("completed")
    expect(entries[0]?.index).toBeUndefined()
    expect(entries[0]?.resume).toBe(false)
  })

  test("marks background task children completed once the child is idle", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "background work",
            agent: "general",
            started: 25,
            background: true,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Background work", created: 25 })],
    })

    // Parent tool completes immediately for background/promote; when the child is
    // not working, surface the normal completed status (same as foreground).
    expect(entries[0]?.status).toBe("completed")
    expect(entries[0]?.background).toBe(true)
  })

  test("keeps background task children running while the child session is active", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "background work",
            agent: "general",
            started: 25,
            background: true,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Background work", created: 25 })],
      statuses: { ses_child: { type: "busy" } },
    })

    expect(entries[0]?.status).toBe("running")
    expect(entries[0]?.background).toBe(true)
  })

  test("marks foreground task children without background flag", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "foreground work",
            agent: "general",
            started: 25,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Foreground work", created: 25 })],
    })

    expect(entries[0]?.background).toBeUndefined()
  })

  test("marks direct child sessions not referenced by task metadata as not used", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_used",
            description: "used task",
            agent: "general",
            started: 25,
          }),
        ],
      },
      sessions: [
        session({ id: "ses_used", parentID: "ses_parent", title: "Used child", created: 25 }),
        session({ id: "ses_unused", parentID: "ses_parent", title: "Unused child", agent: "general", created: 30 }),
      ],
    })

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => [entry.sessionID, entry.usage])).toEqual([
      ["ses_used", undefined],
      ["ses_unused", "not used"],
    ])
  })

  test("marks unreferenced direct child sessions as running while they are active", () => {
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [],
      parts: {},
      sessions: [
        session({ id: "ses_child", parentID: "ses_parent", title: "Active child", agent: "general", created: 50 }),
      ],
      messagesBySession: {
        ses_child: [assistant({ id: "msg_child", sessionID: "ses_child", created: 60, completed: false })],
      },
    })

    expect(entries).toEqual([
      {
        id: "session:ses_child",
        sessionID: "ses_child",
        title: "Active child",
        agent: "general",
        created: 50,
        status: "running",
        index: 1,
        resume: false,
      },
    ])
  })

  test("uses child session activity over completed task tool status", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "keep working",
            agent: "general",
            started: 25,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Keep working", created: 25 })],
      messagesBySession: {
        ses_child: [assistant({ id: "msg_child", sessionID: "ses_child", created: 30, completed: false })],
      },
    })

    expect(entries[0]?.status).toBe("running")
  })

  test("uses child assistant errors over completed task tool status", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "run bad model",
            agent: "general",
            started: 25,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Run bad model", created: 25 })],
      messagesBySession: {
        ses_child: [
          assistant({
            id: "msg_child",
            sessionID: "ses_child",
            created: 30,
            completed: 40,
            error: { name: "APIError", data: { message: "model not found: gpt-5.4" } },
          }),
        ],
      },
    })

    expect(entries[0]?.status).toBe("error")
  })

  test("shows unreferenced direct child session errors instead of not used", () => {
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [],
      parts: {},
      sessions: [
        session({ id: "ses_child", parentID: "ses_parent", title: "Failed child", agent: "general", created: 50 }),
      ],
      messagesBySession: {
        ses_child: [
          assistant({
            id: "msg_child",
            sessionID: "ses_child",
            created: 60,
            completed: 70,
            error: { name: "APIError", data: { message: "model not found: gpt-5.4" } },
          }),
        ],
      },
    })

    expect(entries).toEqual([
      {
        id: "session:ses_child",
        sessionID: "ses_child",
        title: "Failed child",
        agent: "general",
        created: 50,
        status: "error",
        index: 1,
        resume: false,
      },
    ])
  })

  test("marks completed only when the child assistant has completed", () => {
    const message = assistant({ id: "msg_1", sessionID: "ses_parent", created: 10 })
    const entries = collectSessionChildAgentEntries({
      sessionID: "ses_parent",
      messages: [message],
      parts: {
        msg_1: [
          task({
            id: "prt_1",
            sessionID: "ses_parent",
            messageID: "msg_1",
            childID: "ses_child",
            description: "done work",
            agent: "general",
            started: 25,
          }),
        ],
      },
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Done work", created: 25 })],
      messagesBySession: {
        ses_child: [assistant({ id: "msg_child", sessionID: "ses_child", created: 30, completed: 40 })],
      },
      statuses: {
        ses_child: { type: "busy" } as SessionStatus,
      },
    })

    expect(entries[0]?.status).toBe("completed")
  })
})
