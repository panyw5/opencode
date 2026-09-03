import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2"

// `./rows` transitively imports @solidjs/router and @kobalte/core (via
// @opencode-ai/ui/message-part), whose module scopes call client-only APIs that
// throw under bun:test. Follow the repo-wide pattern: mock those modules, then
// import the module under test lazily.
const KOBALTE_SUBPATHS = [
  "accordion",
  "button",
  "checkbox",
  "collapsible",
  "context-menu",
  "dialog",
  "dropdown-menu",
  "hover-card",
  "popover",
  "progress",
  "radio-group",
  "segmented-control",
  "select",
  "switch",
  "tabs",
  "text-field",
  "toast",
  "tooltip",
]
const KOBALTE_EXPORTS = [
  "Accordion",
  "Button",
  "Checkbox",
  "Collapsible",
  "ContextMenu",
  "Dialog",
  "DropdownMenu",
  "HoverCard",
  "Popover",
  "Progress",
  "RadioGroup",
  "SegmentedControl",
  "Select",
  "Switch",
  "Tabs",
  "TextField",
  "Toast",
  "Tooltip",
]
const kobalteStub = () => {
  const target: Record<string, unknown> = {}
  for (const name of KOBALTE_EXPORTS) target[name] = new Proxy({}, { get: () => () => undefined })
  target.toaster = new Proxy(() => undefined, { get: () => () => undefined })
  return new Proxy(target, {
    get: (obj, key) => Reflect.get(obj, key),
    ownKeys: () => Reflect.ownKeys(target),
  })
}

let construct: (typeof import("./rows"))["Timeline"]["constructMessageRows"]

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    A: () => undefined,
    Navigate: () => undefined,
    Route: () => undefined,
    Router: () => undefined,
    useIsRouting: () => false,
    useLocation: () => ({ pathname: "/", search: "", hash: "", state: undefined, key: "" }),
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  for (const subpath of KOBALTE_SUBPATHS) mock.module(`@kobalte/core/${subpath}`, () => kobalteStub())
  const mod = await import("./rows")
  construct = mod.Timeline.constructMessageRows
})

const userMessage = (id: string): UserMessage => ({
  id,
  sessionID: "ses_test",
  role: "user",
  time: { created: 0 },
  agent: "build",
  model: { providerID: "test", modelID: "test" },
})

const assistantMessage = (id: string, parentID: string): AssistantMessage => ({
  id,
  sessionID: "ses_test",
  parentID,
  role: "assistant",
  time: { created: 0, completed: 1 },
  agent: "build",
  modelID: "test",
  providerID: "test",
  mode: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const textPart = (messageID: string, text: string, synthetic = false): Part =>
  ({
    id: `prt_${messageID}_${text.length}`,
    sessionID: "ses_test",
    messageID,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
  }) as TextPart

const partsByID = (parts: Part[]) => (messageID: string) => parts.filter((part) => part.messageID === messageID)

describe("constructMessageRows", () => {
  test("keeps the row for a normal user message", () => {
    const message = userMessage("user-1")
    const rows = construct(message, partsByID([textPart("user-1", "hello")]), [], 0, true, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["UserMessage"])
  })

  test("keeps the row for a synthetic math-worker event panel", () => {
    const message = userMessage("evt-1")
    const event: Part = {
      id: "prt_evt-1",
      sessionID: "ses_test",
      messageID: "evt-1",
      type: "text",
      text: '<math_worker_event kind="completed">report</math_worker_event>',
      synthetic: true,
      metadata: { kind: "math-worker-event", eventKind: "completed" },
    } as unknown as Part
    const rows = construct(message, partsByID([event]), [], 1, true, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["TurnGap", "UserMessage"])
  })

  test("skips the row for an unknown synthetic-only event", () => {
    const message = userMessage("evt-unknown")
    const event: Part = {
      id: "prt_evt-unknown",
      sessionID: "ses_test",
      messageID: "evt-unknown",
      type: "text",
      text: "internal event",
      synthetic: true,
      metadata: { kind: "internal-event" },
    } as unknown as Part
    const rows = construct(message, partsByID([event]), [], 1, true, true, "idle", false)
    expect(rows).toEqual([])
  })

  test("keeps the row for a synthetic background-shell injection", () => {
    const message = userMessage("evt-2")
    const event: Part = {
      id: "prt_evt-2",
      sessionID: "ses_test",
      messageID: "evt-2",
      type: "text",
      text: "Background shell completed: sleep 1",
      synthetic: true,
      metadata: { kind: "background-shell-injection" },
    } as unknown as Part
    const rows = construct(message, partsByID([event]), [], 1, true, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["TurnGap", "UserMessage"])
  })

  test("keeps an anchor row for an attachment-only user message", () => {
    const message = userMessage("attachment-1")
    const part: Part = {
      id: "prt_attachment-1",
      sessionID: "ses_test",
      messageID: "attachment-1",
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,YQ==",
    }
    const rows = construct(message, partsByID([part]), [], 1, true, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["TurnGap", "UserMessage"])
  })

  test("uses a comment strip as the anchor for a comment-only user message", () => {
    const message = userMessage("comment-1")
    const part: Part = {
      id: "prt_comment-1",
      sessionID: "ses_test",
      messageID: "comment-1",
      type: "text",
      text: "comment context",
      synthetic: true,
      metadata: { opencodeComment: { path: "src/app.ts", comment: "Check this" } },
    } as unknown as Part
    const rows = construct(message, partsByID([part]), [], 1, true, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["TurnGap", "CommentStrip"])
  })

  test("does not create a user anchor for subtask-only content", () => {
    const message = userMessage("subtask-1")
    const part: Part = {
      id: "prt_subtask-1",
      sessionID: "ses_test",
      messageID: "subtask-1",
      type: "subtask",
      prompt: "internal",
      description: "internal",
      agent: "test",
      command: "research",
    }
    const rows = construct(message, partsByID([part]), [], 1, true, true, "idle", false)
    expect(rows).toEqual([])
  })

  test("keeps the turn gap when the hidden message still produced assistant output", () => {
    const message = userMessage("evt-3")
    const event: Part = {
      id: "prt_evt-3",
      sessionID: "ses_test",
      messageID: "evt-3",
      type: "text",
      text: "internal event",
      synthetic: true,
      metadata: { kind: "internal-event" },
    } as unknown as Part
    const assistant = assistantMessage("assistant-3", "evt-3")
    const assistantText = textPart("assistant-3", "done")
    const rows = construct(
      message,
      (id) => (id === "evt-3" ? [event] : [assistantText]),
      [assistant],
      1,
      true,
      true,
      "idle",
      false,
    )
    expect(rows.map((row) => row._tag)).toEqual(["TurnGap", "AssistantPart"])
  })

  test("keeps the interrupted divider for a hidden message with an aborted assistant reply", () => {
    const message = userMessage("evt-4")
    const event: Part = {
      id: "prt_evt-4",
      sessionID: "ses_test",
      messageID: "evt-4",
      type: "text",
      text: "internal event",
      synthetic: true,
      metadata: { kind: "internal-event" },
    } as unknown as Part
    const aborted = {
      ...assistantMessage("assistant-4", "evt-4"),
      error: { name: "MessageAbortedError", data: { message: "Aborted" } } as const,
    }
    const rows = construct(message, partsByID([event]), [aborted], 1, true, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["TurnGap", "TurnDivider"])
  })

  test("keeps the compaction divider for a compaction-only message", () => {
    const message = userMessage("compaction-1")
    const part: Part = {
      id: "prt_compaction-1",
      sessionID: "ses_test",
      messageID: "compaction-1",
      type: "compaction",
      synthetic: true,
    } as unknown as Part
    const rows = construct(message, partsByID([part]), [], 1, true, true, "idle", false)
    expect(rows.map((row) => row._tag)).toEqual(["TurnGap", "TurnDivider"])
  })
})
