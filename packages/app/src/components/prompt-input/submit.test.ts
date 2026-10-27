import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ContextItem, Prompt } from "@/context/prompt"
import { pendingSessionKey, pendingSessionSubmissions } from "./pending-session"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let sendFollowupDraft: typeof import("./submit").sendFollowupDraft
const toasts: Array<{ title?: string; description?: string }> = []

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateOptions: Array<{ directory: string; body?: { cwd?: string } }> = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string; variant?: string }
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const sentCommands: Array<{ directory: string; messageID?: string }> = []
const sentPrompts: Array<{ directory: string; sessionID: string }> = []
const flushedSessions: Array<{ directory: string; sessionID: string }> = []
const abortedSessions: Array<{ directory: string; sessionID: string }> = []
const syncedDirectories: string[] = []
const messagePages: Record<string, Array<{ info: { id: string } }>> = {}
const syncEvents: string[] = []
const sessionTabEvents: string[] = []
const promptResetScopes: Array<{ dir: string; id?: string } | undefined> = []
const contextItems: (ContextItem & { key: string })[] = []
const restoredContextScopes: Array<{ dir: string; id?: string } | undefined> = []

let params: { dir?: string; id?: string; draftID?: string } = {}
let current = "/repo/worktree-a"
let root = "/repo/main"
let selected = "/repo/worktree-a"
let variant: string | undefined
let integration: string | undefined
let sessionCreateGate: { promise: Promise<void>; resolve: () => void } | undefined
let sessionCreateError: Error | undefined
let sessionCreateCalls = 0
const sentMessageIDs: string[] = []
const sentPartIDs: string[][] = []
let promptGate: Promise<void> | undefined
let abortGate: Promise<void> | undefined
let onPrompt: (() => void) | undefined
let onAbort: (() => void) | undefined

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const clientFor = (directory: string, track = true) => {
  if (track) createdClients.push(directory)
  return {
    session: {
      create: async (_parameters?: unknown, options?: { body?: { cwd?: string } }) => {
        sessionCreateCalls++
        await sessionCreateGate?.promise
        if (sessionCreateError) throw sessionCreateError
        createdSessions.push(directory)
        sessionCreateOptions.push({ directory, body: options?.body })
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      messages: async () => ({ data: messagePages[directory] ?? [] }),
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: { sessionID: string; messageID: string; parts: { id: string }[] }) => {
        sentMessageIDs.push(input.messageID)
        sentPartIDs.push(input.parts.map((part) => part.id))
        sentPrompts.push({ directory, sessionID: input.sessionID })
        onPrompt?.()
        await promptGate
        return { data: undefined }
      },
      flush: async (input: { sessionID: string }) => {
        flushedSessions.push({ directory, sessionID: input.sessionID })
        return { data: undefined }
      },
      command: async (input: { messageID?: string }) => {
        sentCommands.push({ directory, messageID: input.messageID })
        return { data: undefined }
      },
      abort: async (input: { sessionID: string }) => {
        abortedSessions.push({ directory, sessionID: input.sessionID })
        onAbort?.()
        await abortGate
        return { data: undefined }
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => (href: string) => sessionTabEvents.push(`navigate:${href}`),
    useParams: () => params,
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: (input: { title?: string; description?: string }) => {
      toasts.push(input)
      return 0
    },
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
    checksum: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: (scope?: { dir: string; id?: string }) => promptResetScopes.push(scope),
      set: () => undefined,
      context: {
        add: (item: ContextItem & { key: string }, scope?: { dir: string; id?: string }) => {
          contextItems.push(item)
          restoredContextScopes.push(scope)
        },
        remove: (key: string) => {
          const index = contextItems.findIndex((item) => item.key === key)
          if (index >= 0) contextItems.splice(index, 1)
        },
        items: () => contextItems,
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      sessionBar: {
        drafts: () => [{ id: "draft-1", directory: current }],
      },
      handoff: {
        setTabs: (directory: string, sessionID: string, draftID: string) => {
          sessionTabEvents.push(`handoff:${directory}:${sessionID}:${draftID}`)
        },
      },
    }),
  }))

  mock.module("@/context/session-tabs", () => ({
    useSessionTabs: () => ({
      ensureOpen: (tab: { directory: string; id: string }) => {
        sessionTabEvents.push(`ensure:${tab.directory}:${tab.id}`)
      },
      promoteDraft: (tab: { directory: string; id: string }, draft: { id: string; directory: string }) => {
        sessionTabEvents.push(`promote:${tab.directory}:${tab.id}:${draft.id}:${draft.directory}`)
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        directory: current,
        client: clientFor(current, false),
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      project: { worktree: root },
      data: { command: [] },
      session: {
        created: (input: { directory?: string; info: { id: string; title?: string } }) => {
          const directory = input.directory ?? current
          syncedDirectories.push(directory)
          storedSessions[directory] ??= []
          storedSessions[directory].push(input.info)
        },
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string }; variant?: string }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      session: {
        status: {
          set: () => undefined,
        },
        todo: {
          set: () => undefined,
        },
        messages: {
          page: async ({ directory }: { directory: string }) => ({
            session: (messagePages[directory] ?? []).map((item) => item.info),
          }),
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/server", () => ({
    useServer: () => ({
      isLocal: () => true,
      current: integration ? { integration } : undefined,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  sendFollowupDraft = mod.sendFollowupDraft
})

afterAll(() => {
  mock.restore()
})

beforeEach(() => {
  for (const key of Object.keys(pendingSessionSubmissions.entries)) pendingSessionSubmissions.finish(key)
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateOptions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  params = { dir: "/repo/worktree-a", draftID: "draft-1" }
  sentShell.length = 0
  sentCommands.length = 0
  sentPrompts.length = 0
  flushedSessions.length = 0
  abortedSessions.length = 0
  syncedDirectories.length = 0
  syncEvents.length = 0
  sessionTabEvents.length = 0
  promptResetScopes.length = 0
  contextItems.length = 0
  restoredContextScopes.length = 0
  toasts.length = 0
  current = "/repo/worktree-a"
  root = "/repo/main"
  selected = "/repo/worktree-a"
  variant = undefined
  integration = undefined
  sessionCreateGate = undefined
  sessionCreateError = undefined
  sessionCreateCalls = 0
  sentMessageIDs.length = 0
  sentPartIDs.length = 0
  promptGate = undefined
  onPrompt = undefined
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
  for (const key of Object.keys(messagePages)) delete messagePages[key]
})

describe("prompt submit worktree selection", () => {
  const newPromptSubmit = () =>
    createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      newSessionWorktree: () => selected,
    })

  test("shows the first message and clears only its draft before session creation; duplicate submit is ignored", async () => {
    let resolve!: () => void
    sessionCreateGate = {
      promise: new Promise<void>((done) => {
        resolve = done
      }),
      resolve: () => resolve(),
    }
    const submit = newPromptSubmit()
    const event = { preventDefault() {} } as Event
    const operation = submit.handleSubmit(event)
    const key = pendingSessionKey("http://localhost:4096", current, "draft-1")
    const entry = pendingSessionSubmissions.entries[key]!
    expect(entry.phase).toBe("preparing")
    expect(entry.parts.find((part) => part.type === "text")?.text).toBe("ls")
    expect(promptResetScopes).toEqual([{ dir: current, id: "draft-1" }])
    expect(createdSessions).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(sessionTabEvents).toHaveLength(0)
    await submit.handleSubmit(event)
    expect(sessionCreateCalls).toBe(1)
    sessionCreateGate.resolve()
    await operation
    await Bun.sleep(0)
    expect(sentMessageIDs).toEqual([entry.message.id])
    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({ message: { id: entry.message.id }, sessionID: "session-1" })
    expect(pendingSessionSubmissions.entries[key]?.sessionID).toBe("session-1")
    expect(promptResetScopes).toHaveLength(1)
  })

  test("keeps a failed first message and retries once with the original message ID", async () => {
    sessionCreateError = new Error("create unavailable")
    const submit = newPromptSubmit()
    await submit.handleSubmit({ preventDefault() {} } as Event)
    const key = pendingSessionKey("http://localhost:4096", current, "draft-1")
    const entry = pendingSessionSubmissions.entries[key]!
    const messageID = entry.message.id
    expect(entry.phase).toBe("failed")
    expect(entry.error).toBe("create unavailable")
    expect(sentPrompts).toHaveLength(0)
    sessionCreateError = undefined
    entry.retry()
    entry.retry()
    await Bun.sleep(0)
    expect(sessionCreateCalls).toBe(2)
    expect(createdSessions).toHaveLength(1)
    expect(sentMessageIDs).toEqual([messageID])
    expect(optimistic).toHaveLength(1)
  })

  test("background first-message creation does not navigate away from a different draft", async () => {
    let resolve!: () => void
    sessionCreateGate = {
      promise: new Promise<void>((done) => {
        resolve = done
      }),
      resolve: () => resolve(),
    }
    const submit = newPromptSubmit()
    const operation = submit.handleSubmit({ preventDefault() {} } as Event)
    params.draftID = "draft-2"
    sessionCreateGate.resolve()
    await operation
    await Bun.sleep(0)
    expect(sessionTabEvents).toEqual(["promote:/repo/worktree-a:session-1:draft-1:/repo/worktree-a"])
    expect(promptResetScopes).toEqual([{ dir: current, id: "draft-1" }])
    expect(sentPrompts).toHaveLength(1)
    expect(pendingSessionSubmissions.get("http://localhost:4096", current, params)).toBeUndefined()
  })

  test("a failed send retries the existing session and keeps the same message and part IDs", async () => {
    onPrompt = () => {
      throw new Error("send unavailable")
    }
    const submit = newPromptSubmit()
    await submit.handleSubmit({ preventDefault() {} } as Event)
    const key = pendingSessionKey("http://localhost:4096", current, "draft-1")
    for (let attempt = 0; attempt < 100 && pendingSessionSubmissions.entries[key]?.phase !== "failed"; attempt++) {
      await Bun.sleep(10)
    }
    const entry = pendingSessionSubmissions.entries[key]!
    expect(entry.phase).toBe("failed")
    expect(createdSessions).toHaveLength(1)
    onPrompt = undefined
    entry.retry()
    entry.retry()
    await Bun.sleep(0)
    expect(sessionCreateCalls).toBe(1)
    expect(sentMessageIDs).toEqual([entry.message.id, entry.message.id])
    expect(sentPartIDs[1]).toEqual(sentPartIDs[0])
  })

  test("promotes a submitted draft in the background after the user opens another draft", async () => {
    let resolve!: () => void
    sessionCreateGate = {
      promise: new Promise<void>((done) => {
        resolve = done
      }),
      resolve: () => resolve(),
    }
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    params.draftID = "draft-2"
    sessionCreateGate.resolve()
    await submitted

    expect(sessionTabEvents).toEqual(["promote:/repo/main:session-1:draft-1:/repo/worktree-a"])
    expect(promptResetScopes).toEqual([{ dir: "/repo/worktree-a", id: "draft-1" }])
  })

  test("routes main selection to the project root from a sandbox page", async () => {
    selected = "main"

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/main"])
    expect(createdSessions).toEqual(["/repo/main"])
    expect(sentShell).toEqual(["/repo/main"])
    expect(promoted).toEqual([{ directory: "/repo/main", sessionID: "session-1" }])
    expect(sessionTabEvents).toEqual([
      "handoff:/repo/main:session-1:draft-1",
      "promote:/repo/main:session-1:draft-1:/repo/worktree-a",
      "navigate://repo/main/session/session-1",
    ])
  })

  test("keeps GenericAgent sessions on the extra-agent directory and sends selected cwd", async () => {
    integration = "genericagent"
    current = "/genericagent"
    root = "/genericagent"
    selected = "/repo/worktree-a"

    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(createdClients).toEqual([])
    expect(createdSessions).toEqual(["/genericagent"])
    expect(sessionCreateOptions).toEqual([{ directory: "/genericagent", body: { cwd: "/repo/worktree-a" } }])
    expect(sentShell).toEqual(["/genericagent"])
    expect(promoted).toEqual([{ directory: "/genericagent", sessionID: "session-1" }])
  })

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("adds optimistic follow-up before marking the session busy", async () => {
    const ok = await sendFollowupDraft({
      client: clientFor("/repo/main", false) as never,
      globalSync: {
        session: {
          status: {
            set: (_directory: string, _sessionID: string, status: { type?: string }) => {
              syncEvents.push(`status:${status.type}`)
            },
          },
        },
      } as never,
      sync: {
        data: { command: [] },
        session: {
          optimistic: {
            add: () => syncEvents.push("optimistic:add"),
            remove: () => syncEvents.push("optimistic:remove"),
          },
        },
      } as never,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: promptValue,
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
      messageID: "message-1",
      optimisticBusy: true,
    })

    expect(ok).toBe(true)
    expect(syncEvents.slice(0, 2)).toEqual(["optimistic:add", "status:busy"])
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })

  test("treats command send as delivered when message appears after request failure", async () => {
    messagePages["/repo/main"] = [{ info: { id: "message-1" } }]
    const err = new Error("Load failed")
    const commandOptimistic: Array<{
      parts: Array<{ text: string; synthetic?: boolean; metadata?: Record<string, unknown> }>
    }> = []
    const commandOptimisticCompleted: string[] = []
    const client = {
      session: {
        command: async () => {
          throw err
        },
        messages: async () => ({ data: messagePages["/repo/main"] ?? [] }),
      },
    }

    const ok = await sendFollowupDraft({
      client: client as never,
      globalSync: {
        session: {
          messages: {
            page: async () => ({ session: messagePages["/repo/main"].map((item) => item.info) }),
          },
          status: {
            set: () => undefined,
          },
        },
      } as never,
      sync: {
        data: { command: [{ name: "foo" }] },
        session: {
          optimistic: {
            add: (input: (typeof commandOptimistic)[number]) => commandOptimistic.push(input),
            complete: (input: { messageID: string }) => commandOptimisticCompleted.push(input.messageID),
            remove: () => undefined,
          },
        },
      } as never,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "/foo", start: 0, end: 4 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
      messageID: "message-1",
    })

    expect(ok).toBe(true)
    expect(toasts).toEqual([])
    expect(sentCommands).toEqual([])
    expect(commandOptimistic).toMatchObject([
      {
        parts: [
          { text: "/foo" },
          { text: "", synthetic: true, metadata: { kind: "command-injection", pending: true } },
        ],
      },
    ])
    expect(commandOptimisticCompleted).toEqual(["message-1"])
  })

  test("abort still reaches the backend when a local pending prompt exists", async () => {
    params = { id: "session-1" }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resetInputUndo: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await submit.abort()

    expect(abortedSessions).toEqual([{ directory: "/repo/worktree-a", sessionID: "session-1" }])
  })
})

describe("prompt submit intervene", () => {
  test("rapid stop orders send acknowledgement, stop completion and next send", async () => {
    params = { id: "session-9" }
    const sent = Promise.withResolvers<void>()
    const acknowledged = Promise.withResolvers<void>()
    const abortStarted = Promise.withResolvers<void>()
    const abortFinished = Promise.withResolvers<void>()
    const nextSent = Promise.withResolvers<void>()
    promptGate = acknowledged.promise
    abortGate = abortFinished.promise
    onPrompt = sent.resolve
    onAbort = abortStarted.resolve
    const submit = createPromptSubmit(baseInput({ working: () => false }))
    try {
      await submit.handleSubmit({ preventDefault() {} } as Event, { intervene: true })
      await sent.promise
      const firstStop = submit.abort()
      expect(submit.abort()).toBe(firstStop)
      onPrompt = nextSent.resolve
      await submit.handleSubmit({ preventDefault() {} } as Event, { intervene: true })
      expect(abortedSessions).toHaveLength(0)
      expect(sentPrompts).toHaveLength(1)
      acknowledged.resolve()
      await abortStarted.promise
      expect(sentPrompts).toHaveLength(1)
      abortFinished.resolve()
      await firstStop
      await nextSent.promise
      expect(abortedSessions).toHaveLength(1)
      expect(sentPrompts).toHaveLength(2)
    } finally {
      acknowledged.resolve()
      abortFinished.resolve()
      promptGate = undefined
      abortGate = undefined
      onPrompt = undefined
      onAbort = undefined
    }
  })
  const baseInput = (overrides?: Partial<Parameters<typeof createPromptSubmit>[0]>) => ({
    info: () => ({ id: "session-9" }),
    imageAttachments: () => [],
    commentCount: () => 0,
    autoAccept: () => false,
    mode: () => "normal" as const,
    working: () => true,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: (value: Prompt) =>
      value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    resetInputUndo: () => undefined,
    shouldQueue: () => true,
    onQueue: () => undefined,
    onSubmit: () => undefined,
    ...overrides,
  })

  const reference = {
    key: "ref",
    type: "session" as const,
    sessionID: "ses_source",
    directory: "/source",
    title: "Source",
    summary: "Context",
    updatedAt: 1700000000000,
  }

  test("consumes a reference on send and restores it to the original draft on failure", async () => {
    params = { dir: "/repo/worktree-a", id: "session-9" }
    contextItems.push(reference)
    const gate = Promise.withResolvers<void>()
    promptGate = gate.promise
    const submit = createPromptSubmit(baseInput({ working: () => false, shouldQueue: () => false }))
    try {
      await submit.handleSubmit({ preventDefault() {} } as Event)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(contextItems).toEqual([])
      params = { dir: "/another", id: "session-10" }
      gate.reject(new Error("test send failure"))
      // Failed sends check server delivery for 550 ms before restoring a draft.
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(contextItems).toEqual([reference])
      expect(restoredContextScopes).toEqual([{ dir: "/repo/worktree-a", id: "session-9" }])
    } finally {
      gate.resolve()
      promptGate = undefined
    }
  })

  test("preserves references in queued drafts", async () => {
    params = { dir: "/repo/worktree-a", id: "session-9" }
    contextItems.push(reference)
    const queued: { context: ContextItem[] }[] = []
    const submit = createPromptSubmit(baseInput({ onQueue: (draft) => queued.push(draft) }))
    await submit.handleSubmit({ preventDefault() {} } as Event)
    expect(queued[0]?.context).toEqual([reference])
    expect(contextItems).toEqual([])
  })

  test("preserves inline session snapshots in queued drafts", async () => {
    params = { dir: "/repo/worktree-a", id: "session-9" }
    const original = promptValue.slice()
    const capsule = { type: "session" as const, reference, content: "@Source", start: 0, end: 7 }
    promptValue.splice(0, promptValue.length, capsule)
    try {
      const queued: Array<{ prompt: Prompt; context: ContextItem[] }> = []
      const submit = createPromptSubmit(baseInput({ onQueue: (draft) => queued.push(draft) }))
      await submit.handleSubmit({ preventDefault() {} } as Event)
      expect(queued[0]?.prompt).toEqual([capsule])
      expect(queued[0]?.context).toEqual([])
    } finally {
      promptValue.splice(0, promptValue.length, ...original)
    }
  })

  test("rejects slash-command followups with inline session references rather than dropping context", async () => {
    await expect(
      sendFollowupDraft({
        client: clientFor("/repo/main", false) as never,
        globalSync: {} as never,
        sync: { data: { command: [{ name: "foo" }] } } as never,
        draft: {
          sessionID: "session-9",
          sessionDirectory: "/repo/main",
          prompt: [
            { type: "text", content: "/foo ", start: 0, end: 5 },
            { type: "session", reference, content: "@Source", start: 5, end: 12 },
          ],
          context: [],
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        },
      }),
    ).rejects.toThrow("Session references require a regular prompt")
    expect(sentCommands).toEqual([])
  })

  test("transforms only the submitted draft text while preserving queued prompt content", async () => {
    params = { id: "session-9", dir: "/repo/worktree-a" }
    const queued: Array<{ prompt: Prompt }> = []
    const submit = createPromptSubmit(
      baseInput({
        transformPromptText: (text) => `initialized: ${text}`,
        onQueue: (draft) => queued.push(draft),
      }),
    )

    await submit.handleSubmit({ preventDefault() {} } as Event)

    expect(queued[0]?.prompt).toEqual([{ type: "text", content: "initialized: ls", start: 0, end: 15 }])
  })

  test("intervene bypasses the queue, posts immediately and flushes the session", async () => {
    params = { dir: "/repo/worktree-a", id: "session-9" }
    const queued: unknown[] = []
    const submit = createPromptSubmit(baseInput({ onQueue: (draft) => queued.push(draft) }))

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event, { intervene: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(queued).toEqual([])
    expect(sentPrompts).toEqual([{ directory: "/repo/worktree-a", sessionID: "session-9" }])
    expect(flushedSessions).toEqual([{ directory: "/repo/worktree-a", sessionID: "session-9" }])
    expect(abortedSessions).toEqual([])
  })

  test("regular submit while busy still honors the queue and never flushes", async () => {
    params = { dir: "/repo/worktree-a", id: "session-9" }
    const queued: unknown[] = []
    const submit = createPromptSubmit(
      baseInput({
        onQueue: (draft) => queued.push(draft),
      }),
    )

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(queued).toHaveLength(1)
    expect(sentPrompts).toEqual([])
    expect(flushedSessions).toEqual([])
  })

  test("the stop button never sends or queues a nonempty draft", async () => {
    params = { dir: "/repo/worktree-a", id: "session-9" }
    const queued: unknown[] = []
    const submit = createPromptSubmit(baseInput({ onQueue: (draft) => queued.push(draft) }))
    await submit.handlePrimaryAction({ preventDefault() {} } as Event, "stop")
    expect(abortedSessions).toEqual([{ directory: "/repo/worktree-a", sessionID: "session-9" }])
    expect(sentPrompts).toEqual([])
    expect(sentCommands).toEqual([])
    expect(queued).toEqual([])
    expect(promptValue[0]).toMatchObject({ content: "ls" })
  })

  test("a displayed stop action remains stop even if streaming just finished", async () => {
    params = { dir: "/repo/worktree-a", id: "session-9" }
    const submit = createPromptSubmit(baseInput({ working: () => false }))
    await submit.handlePrimaryAction({ preventDefault() {} } as Event, "stop")
    expect(abortedSessions).toEqual([{ directory: "/repo/worktree-a", sessionID: "session-9" }])
    expect(sentPrompts).toEqual([])
  })
})
