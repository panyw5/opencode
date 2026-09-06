import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

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

let params: { dir?: string; id?: string; draftID?: string } = {}
let current = "/repo/worktree-a"
let root = "/repo/main"
let selected = "/repo/worktree-a"
let variant: string | undefined
let integration: string | undefined
let sessionCreateGate: { promise: Promise<void>; resolve: () => void } | undefined

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const clientFor = (directory: string, track = true) => {
  if (track) createdClients.push(directory)
  return {
    session: {
      create: async (_parameters?: unknown, options?: { body?: { cwd?: string } }) => {
        await sessionCreateGate?.promise
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
      promptAsync: async (input: { sessionID: string }) => {
        sentPrompts.push({ directory, sessionID: input.sessionID })
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
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
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
  toasts.length = 0
  current = "/repo/worktree-a"
  root = "/repo/main"
  selected = "/repo/worktree-a"
  variant = undefined
  integration = undefined
  sessionCreateGate = undefined
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
  for (const key of Object.keys(messagePages)) delete messagePages[key]
})

describe("prompt submit worktree selection", () => {
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
  const baseInput = (overrides?: Partial<Parameters<typeof createPromptSubmit>[0]>) => ({
    info: () => ({ id: "session-9" }),
    imageAttachments: () => [],
    commentCount: () => 0,
    autoAccept: () => false,
    mode: () => "normal" as const,
    working: () => true,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: (value: Prompt) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
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
})
