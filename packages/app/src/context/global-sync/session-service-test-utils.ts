import type { OpencodeClient, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import { pathIdentityKey } from "@opencode-ai/core/util/path"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import type { SessionControllerDeps } from "./session-service-types"

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export const sessionInfo = (id = "session", updated = 1): Session =>
  ({
    id,
    projectID: "project",
    directory: "/project",
    title: id,
    version: "1",
    time: { created: 1, updated },
  }) as Session

export type FakeSessionClient = {
  get: (input: { sessionID: string }) => Promise<{ data?: Session }>
  messages: (input: { sessionID: string; limit: number; before?: string }) => Promise<{
    data?: Array<{ info: any; parts: any[] }>
    response: { headers: { get(name: string): string | null } }
  }>
  todo: (input: { sessionID: string }) => Promise<{ data?: Todo[] }>
  diff: (input: { sessionID: string }) => Promise<{ data?: any[] }>
  status: () => Promise<{ data?: Record<string, SessionStatus> }>
}

const childState = (directory: string): State => ({
  project: "",
  projectMeta: undefined,
  icon: undefined,
  provider: { all: [], connected: [], default: {} },
  config: {},
  path: { state: "", config: "", worktree: "", directory, home: "" },
  status: "complete",
  sessions: "ready",
  session_error: undefined,
  agent: [],
  command: [],
  session: [],
  sessionTotal: 0,
  session_status: {},
  session_diff: {},
  todo: {},
  permission: {},
  question: {},
  mcp: {},
  lsp: [],
  vcs: undefined,
  limit: 5,
  message: {},
  session_history: {},
  part: {},
})

export function createSessionControllerHarness(client: Partial<FakeSessionClient> = {}, directory = "/project") {
  const child = createStore<State>(childState(directory))
  const children = new Map<string, typeof child>([[pathIdentityKey(directory), child]])
  const sdkDirectories: string[] = []
  let revision = 0
  let pins = 0
  const session = {
    get: client.get ?? (async ({ sessionID }) => ({ data: sessionInfo(sessionID) })),
    messages:
      client.messages ??
      (async () => ({ data: [], response: { headers: { get: () => null } } })),
    todo: client.todo ?? (async () => ({ data: [] })),
    diff: client.diff ?? (async () => ({ data: [] })),
    status: client.status ?? (async () => ({ data: {} })),
  }
  const deps: SessionControllerDeps = {
    key: pathIdentityKey,
    isolated: () => false,
    sdk: (directory) => {
      sdkDirectories.push(directory)
      return { session } as unknown as OpencodeClient
    },
    child: (directory) => children.get(pathIdentityKey(directory))!,
    current: (directory, value, mark) => revision === mark && children.get(pathIdentityKey(directory)) === value,
    revision: () => revision,
    pin: () => {
      pins += 1
    },
    unpin: () => {
      pins -= 1
    },
  }
  return {
    deps,
    child,
    session,
    reset() {
      revision += 1
      children.set(pathIdentityKey(directory), createStore<State>(childState(directory)))
    },
    sdkDirectories,
    get pins() {
      return pins
    },
  }
}
