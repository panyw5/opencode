import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  drainPendingDeepLinks,
  parseDeepLink,
  parseNewSessionDeepLink,
} from "./deep-links"
import {
  type AssistantMessage,
  type PermissionRequest,
  type Session,
  type SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import {
  canonicalWorkspaceDir,
  defaultChannelDirectory,
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  expandHomePath,
  filterImChannelSessions,
  findImChannelByDirectory,
  hasProjectPermissions,
  imChannelProject,
  isInitialSessionLoad,
  latestProjectSession,
  latestRootSession,
  permissionAlertUsesToast,
  projectOwner,
  resolveChannelDirectory,
  sessionByOneBasedIndex,
  sortedProjectSessions,
  isScheduledSessionTitle,
  stripImChannelTitle,
  stripScheduledSessionTitle,
  latestWorkspaceSession,
  waitForMatch,
  workingSessionTreeIDs,
  workspaceKey,
  workspacePathAliases,
  sameWorkspacePath,
} from "./helpers"
import { projectSelected } from "./sidebar-project-helpers"
import type { Project } from "@opencode-ai/sdk/v2"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

test("permission alerts use the direct session tab instead of an in-app toast", () => {
  expect(
    permissionAlertUsesToast({ sessionID: "child", sessions: [], openSessionIDs: ["child"] }),
  ).toBe(false)
})

test("permission alerts use an open parent tab for child requests", () => {
  expect(
    permissionAlertUsesToast({
      sessionID: "child",
      sessions: [{ id: "parent" }, { id: "child", parentID: "parent" }],
      openSessionIDs: ["parent"],
    }),
  ).toBe(false)
})

test("permission alerts keep the toast when no related tab is open", () => {
  expect(
    permissionAlertUsesToast({
      sessionID: "child",
      sessions: [{ id: "parent" }, { id: "child", parentID: "parent" }],
      openSessionIDs: ["unrelated"],
    }),
  ).toBe(true)
})

test("permission alerts do not toast for the current session tree", () => {
  expect(
    permissionAlertUsesToast({
      sessionID: "child",
      sessions: [{ id: "parent" }, { id: "child", parentID: "parent" }],
      openSessionIDs: [],
      currentSessionID: "parent",
    }),
  ).toBe(false)
})

const assistant = (input: { id: string; sessionID: string; completed?: number }) =>
  ({
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    parentID: "msg_parent",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/root", root: "/root" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: input.completed },
  }) as AssistantMessage

describe("layout deep links", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
  })

  test("ignores non-project deep links", () => {
    expect(parseDeepLink("opencode://other?directory=/tmp/demo")).toBeUndefined()
    expect(parseDeepLink("https://example.com")).toBeUndefined()
  })

  test("ignores malformed deep links safely", () => {
    expect(() => parseDeepLink("opencode://open-project/%E0%A4%A%")).not.toThrow()
    expect(parseDeepLink("opencode://open-project/%E0%A4%A%")).toBeUndefined()
  })

  test("parses links when URL.canParse is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(URL, "canParse")
    Object.defineProperty(URL, "canParse", { configurable: true, value: undefined })
    try {
      expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
    } finally {
      if (original) Object.defineProperty(URL, "canParse", original)
      if (!original) Reflect.deleteProperty(URL, "canParse")
    }
  })

  test("ignores open-project deep links without directory", () => {
    expect(parseDeepLink("opencode://open-project")).toBeUndefined()
    expect(parseDeepLink("opencode://open-project?directory=")).toBeUndefined()
  })

  test("collects only valid open-project directories", () => {
    const result = collectOpenProjectDeepLinks([
      "opencode://open-project?directory=/a",
      "opencode://other?directory=/b",
      "opencode://open-project?directory=/c",
    ])
    expect(result).toEqual(["/a", "/c"])
  })

  test("parses new-session deep links with optional prompt", () => {
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo")).toEqual({ directory: "/tmp/demo" })
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo&prompt=hello%20world")).toEqual({
      directory: "/tmp/demo",
      prompt: "hello world",
    })
  })

  test("ignores new-session deep links without directory", () => {
    expect(parseNewSessionDeepLink("opencode://new-session")).toBeUndefined()
    expect(parseNewSessionDeepLink("opencode://new-session?directory=")).toBeUndefined()
  })

  test("collects only valid new-session deep links", () => {
    const result = collectNewSessionDeepLinks([
      "opencode://new-session?directory=/a",
      "opencode://open-project?directory=/b",
      "opencode://new-session?directory=/c&prompt=ship%20it",
    ])
    expect(result).toEqual([{ directory: "/a" }, { directory: "/c", prompt: "ship it" }])
  })

  test("drains global deep links once", () => {
    const target = {
      __OPENCODE__: {
        deepLinks: ["opencode://open-project?directory=/a"],
      },
    } as unknown as Window & { __OPENCODE__?: { deepLinks?: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["opencode://open-project?directory=/a"])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })
})

describe("layout workspace helpers", () => {
  test("filters IM channel sessions by title prefix", () => {
    const list = [
      session({ id: "s1", directory: "/p", title: "[im:feishu-bot] abc" }),
      session({ id: "s2", directory: "/p", title: "normal session" }),
      session({ id: "s3", directory: "/p", title: "[im:other] xyz" }),
    ]
    expect(filterImChannelSessions(list, undefined).map((s) => s.id)).toEqual(["s1", "s2", "s3"])
    expect(filterImChannelSessions(list, "feishu-bot").map((s) => s.id)).toEqual(["s1"])
    expect(filterImChannelSessions(list, "missing")).toEqual([])
  })

  test("strips IM channel title prefix for display", () => {
    expect(stripImChannelTitle("[im:cc] oc_abc123", "cc")).toBe("oc_abc123")
    expect(stripImChannelTitle("normal", "cc")).toBe("normal")
    expect(stripImChannelTitle("[im:cc]", "cc")).toBe("[im:cc]")
  })

  test("detects and strips scheduled session title marker", () => {
    expect(isScheduledSessionTitle("[scheduled] Nightly review")).toBe(true)
    expect(isScheduledSessionTitle("normal")).toBe(false)
    expect(stripScheduledSessionTitle("[scheduled] Nightly review")).toBe("Nightly review")
    expect(stripScheduledSessionTitle("normal")).toBe("normal")
    expect(stripScheduledSessionTitle("[scheduled]")).toBe("[scheduled]")
  })

  test("resolves per-channel work directory under opencode config", () => {
    const configDir = "/Users/me/.config/opencode"
    expect(defaultChannelDirectory("work-feishu", configDir)).toBe(
      "/Users/me/.config/opencode/channels/work-feishu",
    )
    expect(expandHomePath("~/bots/feishu", "/Users/me")).toBe("/Users/me/bots/feishu")
    expect(resolveChannelDirectory("work-feishu", undefined, configDir, "/Users/me")).toBe(
      "/Users/me/.config/opencode/channels/work-feishu",
    )
    expect(resolveChannelDirectory("work-feishu", "~/custom", configDir, "/Users/me")).toBe(
      "/Users/me/custom",
    )
    expect(resolveChannelDirectory("work-feishu", "/abs/path", configDir, "/Users/me")).toBe(
      "/abs/path",
    )
  })

  test("normalizes Windows channel directories for exact session queries", () => {
    const configDir = "C:\\Users\\me\\.config\\opencode"
    expect(defaultChannelDirectory("work-feishu", configDir)).toBe(
      "C:\\Users\\me\\.config\\opencode\\channels\\work-feishu",
    )
    expect(
      resolveChannelDirectory(
        "work-feishu",
        "C:\\Users\\me\\.config\\opencode/channels/work-feishu",
        configDir,
        "C:\\Users\\me",
      ),
    ).toBe("C:\\Users\\me\\.config\\opencode\\channels\\work-feishu")
  })

  test("maps a work directory back to an IM channel (independent domain)", () => {
    const configDir = "/Users/me/.config/opencode"
    const home = "/Users/me"
    const channels = {
      "work-feishu": { type: "feishu" as const },
      "custom-bot": { type: "discord" as const, directory: "~/bots/discord" },
      disabled: { type: "feishu" as const, enabled: false },
    }
    expect(
      findImChannelByDirectory(
        "/Users/me/.config/opencode/channels/work-feishu",
        channels,
        configDir,
        home,
      ),
    ).toEqual({
      name: "work-feishu",
      type: "feishu",
      directory: "/Users/me/.config/opencode/channels/work-feishu",
    })
    expect(findImChannelByDirectory("/Users/me/bots/discord", channels, configDir, home)).toEqual({
      name: "custom-bot",
      type: "discord",
      directory: "/Users/me/bots/discord",
    })
    expect(
      findImChannelByDirectory(
        "/Users/me/.config/opencode/channels/disabled",
        channels,
        configDir,
        home,
      ),
    ).toBeUndefined()
    expect(findImChannelByDirectory("/some/project", channels, configDir, home)).toBeUndefined()
  })

  test("builds a virtual project for an IM channel session domain", () => {
    const project = imChannelProject("work-feishu", "/Users/me/.config/opencode/channels/work-feishu")
    expect(project).toEqual({
      id: "im:work-feishu",
      worktree: "/Users/me/.config/opencode/channels/work-feishu",
      name: "work-feishu",
      expanded: true,
      vcs: undefined,
      sandboxes: [],
    })
  })

  test("normalizes trailing slash in workspace key", () => {
    expect(workspaceKey("/tmp/demo///")).toBe("/tmp/demo")
    expect(workspaceKey("C:\\tmp\\demo\\\\")).toBe("C:/tmp/demo")
  })

  test("matches selected project against normalized workspace paths", () => {
    expect(projectSelected("/tmp/demo///", "/tmp/demo")).toBe(true)
    expect(projectSelected("/tmp/other", "/tmp/demo", ["/tmp/sandbox"])).toBe(false)
  })

  test("does not select a project from unrelated sandbox metadata", () => {
    const tile = { worktree: "/p", sandboxes: ["/q/sandbox"] } satisfies Partial<Project>
    expect(projectSelected("/c", tile.worktree!, tile.sandboxes)).toBe(false)
  })

  test("does not select a project from stale sandbox metadata after owner resolution", () => {
    expect(projectSelected("/repo", "/old", ["/repo"])).toBe(false)
  })

  test("prefers exact project worktree over stale sandbox ownership", () => {
    const projects = [
      { worktree: "/old", sandboxes: ["/repo"] },
      { worktree: "/repo", sandboxes: [] },
    ]

    const owner = projectOwner("/repo", projects)

    expect(owner?.root).toBe("/repo")
    expect(owner?.project.worktree).toBe("/repo")
    expect(owner?.sandbox).toBe(false)
  })

  test("falls back to sandbox ownership only without a project worktree match", () => {
    const projects = [{ worktree: "/repo", sandboxes: ["/repo-wt"] }]

    const owner = projectOwner("/repo-wt", projects)

    expect(owner?.root).toBe("/repo")
    expect(owner?.directory).toBe("/repo-wt")
    expect(owner?.sandbox).toBe(true)
  })

  test("preserves posix and drive roots in workspace key", () => {
    expect(workspaceKey("/")).toBe("/")
    expect(workspaceKey("///")).toBe("/")
    expect(workspaceKey("C:\\")).toBe("C:/")
    expect(workspaceKey("C://")).toBe("C:/")
    expect(workspaceKey("C:///")).toBe("C:/")
  })

  test("uses canonical workspace dir only for the same workspace", () => {
    expect(canonicalWorkspaceDir("/tmp/demo///", "/tmp/demo")).toBe("/tmp/demo")
    expect(canonicalWorkspaceDir("/tmp/p", "/tmp/s")).toBe("/tmp/p")
  })

  test("waits for async state to match before continuing", async () => {
    let key = "openclaw"
    setTimeout(() => {
      key = "sidecar"
    }, 0)

    await waitForMatch(
      () => key,
      (value) => value === "sidecar",
      { tries: 10, delay: 1 },
    )

    expect(key).toBe("sidecar")
  })

  test("keeps local first while preserving known order", () => {
    const result = effectiveWorkspaceOrder("/root", ["/root", "/b", "/c"], ["/root", "/c", "/a", "/b"])
    expect(result).toEqual(["/root", "/c", "/b"])
  })

  test("finds the latest root session across workspaces", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/root" },
          session: [session({ id: "root", directory: "/root", time: { created: 1, updated: 1, archived: undefined } })],
        },
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "workspace",
              directory: "/workspace",
              time: { created: 2, updated: 2, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("workspace")
  })

  test("sorts project root sessions across workspaces", () => {
    const result = sortedProjectSessions(
      [
        {
          path: { directory: "/root" },
          session: [
            session({
              id: "child",
              directory: "/root",
              parentID: "root",
              time: { created: 9, updated: 9, archived: undefined },
            }),
            session({
              id: "root",
              directory: "/root",
              time: { created: 1, updated: 1, archived: undefined },
            }),
          ],
        },
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "archived",
              directory: "/workspace",
              time: { created: 8, updated: 8, archived: 8 },
            }),
            session({
              id: "workspace",
              directory: "/workspace",
              time: { created: 2, updated: 2, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result.map((item) => item.id)).toEqual(["workspace", "root"])
  })

  test("selects a session by one-based list index", () => {
    const sessions = [
      session({ id: "first", directory: "/workspace" }),
      session({ id: "second", directory: "/workspace" }),
    ]

    expect(sessionByOneBasedIndex(sessions, 1)?.id).toBe("first")
    expect(sessionByOneBasedIndex(sessions, 2)?.id).toBe("second")
    expect(sessionByOneBasedIndex(sessions, 0)).toBeUndefined()
    expect(sessionByOneBasedIndex(sessions, 3)).toBeUndefined()
  })

  test("treats loading sessions as initial load only before visible root sessions exist", () => {
    expect(
      isInitialSessionLoad([
        {
          path: { directory: "/root" },
          sessions: "loading",
          session: [],
        },
      ]),
    ).toBe(true)

    expect(
      isInitialSessionLoad([
        {
          path: { directory: "/root" },
          sessions: "loading",
          session: [session({ id: "root", directory: "/root" })],
        },
      ]),
    ).toBe(false)

    expect(
      isInitialSessionLoad([
        {
          path: { directory: "/root" },
          sessions: "loading",
          session: [session({ id: "child", directory: "/root", parentID: "root" })],
        },
      ]),
    ).toBe(true)
  })

  test("sorts recently updated sessions by timestamp before id", () => {
    const result = sortedProjectSessions(
      [
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "a",
              directory: "/workspace",
              time: { created: 10, updated: 10, archived: undefined },
            }),
            session({
              id: "b",
              directory: "/workspace",
              time: { created: 20, updated: 20, archived: undefined },
            }),
          ],
        },
      ],
      60_000,
    )

    expect(result.map((item) => item.id)).toEqual(["b", "a"])
  })

  test("finds the latest root session inside one workspace only", () => {
    const result = latestWorkspaceSession(
      {
        path: { directory: "/workspace" },
        session: [
          session({
            id: "child",
            directory: "/workspace",
            parentID: "root",
            time: { created: 3, updated: 3, archived: undefined },
          }),
          session({
            id: "root-old",
            directory: "/workspace",
            time: { created: 1, updated: 1, archived: undefined },
          }),
          session({
            id: "root-new",
            directory: "/workspace",
            time: { created: 2, updated: 2, archived: undefined },
          }),
        ],
      },
      120_000,
    )

    expect(result?.id).toBe("root-new")
  })

  test("ignores archived remembered sessions when selecting a workspace session", () => {
    const result = latestWorkspaceSession(
      {
        path: { directory: "/workspace" },
        session: [
          session({
            id: "archived",
            directory: "/workspace",
            time: { created: 4, updated: 4, archived: 4 },
          }),
          session({
            id: "root",
            directory: "/workspace",
            time: { created: 1, updated: 1, archived: undefined },
          }),
        ],
      },
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("detects project permissions with a filter", () => {
    const result = hasProjectPermissions(
      [session({ id: "root", directory: "/root" }), session({ id: "child", directory: "/root", parentID: "root" })],
      {
        root: [{ id: "perm-root" } as PermissionRequest, { id: "perm-hidden" } as PermissionRequest],
        child: [{ id: "perm-child" } as PermissionRequest],
      },
      "/root",
      (item: PermissionRequest) => item.id === "perm-child",
    )

    expect(result).toBe(true)
  })

  test("ignores project permissions filtered out", () => {
    const result = hasProjectPermissions(
      [session({ id: "root", directory: "/root" })],
      {
        root: [{ id: "perm-root" } as PermissionRequest],
      },
      "/root",
      () => false,
    )

    expect(result).toBe(false)
  })

  test("finds a running background child for an idle root session", () => {
    const result = workingSessionTreeIDs({
      sessionID: "root",
      sessions: [
        session({ id: "root", directory: "/root" }),
        session({ id: "background", directory: "/root", parentID: "root" }),
      ],
      statuses: {
        root: { type: "idle" } as SessionStatus,
        background: { type: "busy" } as SessionStatus,
      },
      messages: {},
    })

    expect(result).toEqual(["background"])
  })

  test("finds running nested child agents and ignores unrelated sessions", () => {
    const result = workingSessionTreeIDs({
      sessionID: "root",
      sessions: [
        session({ id: "root", directory: "/root" }),
        session({ id: "child", directory: "/root", parentID: "root" }),
        session({ id: "nested", directory: "/root", parentID: "child" }),
        session({ id: "other", directory: "/root" }),
      ],
      statuses: {
        nested: { type: "busy" } as SessionStatus,
        other: { type: "busy" } as SessionStatus,
      },
      messages: {},
    })

    expect(result).toEqual(["nested"])
  })

  test("does not mark a child whose assistant message already completed", () => {
    const result = workingSessionTreeIDs({
      sessionID: "root",
      sessions: [
        session({ id: "root", directory: "/root" }),
        session({ id: "background", directory: "/root", parentID: "root" }),
      ],
      statuses: { background: { type: "busy" } as SessionStatus },
      messages: { background: [assistant({ id: "msg_child", sessionID: "background", completed: 2 })] },
    })

    expect(result).toEqual([])
  })

  test("ignores archived and child sessions when finding latest root session", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "archived",
              directory: "/workspace",
              time: { created: 10, updated: 10, archived: 10 },
            }),
            session({
              id: "child",
              directory: "/workspace",
              parentID: "parent",
              time: { created: 20, updated: 20, archived: undefined },
            }),
            session({
              id: "root",
              directory: "/workspace",
              time: { created: 30, updated: 30, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("prefers remembered project session when it still exists", () => {
    const result = latestProjectSession(
      {
        root: "/root",
        dirs: ["/root", "/workspace"],
        recent: { directory: "/root", id: "older", at: 999 },
        stores: [
          {
            path: { directory: "/root" },
            session: [
              session({
                id: "older",
                directory: "/root",
                time: { created: 1, updated: 1, archived: undefined },
              }),
            ],
          },
          {
            path: { directory: "/workspace" },
            session: [
              session({
                id: "newer",
                directory: "/workspace",
                time: { created: 2, updated: 2, archived: undefined },
              }),
            ],
          },
        ],
      },
      120_000,
    )

    expect(result?.id).toBe("older")
  })

  test("falls back to latest root session when remembered project session is gone", () => {
    const result = latestProjectSession(
      {
        root: "/root",
        dirs: ["/root", "/workspace"],
        recent: { directory: "/missing", id: "older", at: 999 },
        stores: [
          {
            path: { directory: "/root" },
            session: [
              session({
                id: "root",
                directory: "/root",
                time: { created: 1, updated: 1, archived: undefined },
              }),
            ],
          },
          {
            path: { directory: "/workspace" },
            session: [
              session({
                id: "workspace",
                directory: "/workspace",
                time: { created: 2, updated: 2, archived: undefined },
              }),
            ],
          },
        ],
      },
      120_000,
    )

    expect(result?.id).toBe("workspace")
  })

  test("ignores stores outside the requested project", () => {
    const result = latestProjectSession(
      {
        root: "/root",
        dirs: ["/root", "/workspace"],
        recent: { directory: "/other", id: "other", at: 999 },
        stores: [
          {
            path: { directory: "/root" },
            session: [
              session({
                id: "root",
                directory: "/root",
                time: { created: 1, updated: 1, archived: undefined },
              }),
            ],
          },
          {
            path: { directory: "/other" },
            session: [
              session({
                id: "other",
                directory: "/other",
                time: { created: 99, updated: 99, archived: undefined },
              }),
            ],
          },
        ],
      },
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("formats fallback project display name", () => {
    expect(displayName({ worktree: "/tmp/app" })).toBe("app")
    expect(displayName({ worktree: "/tmp/app", name: "My App" })).toBe("My App")
  })

  test("extracts api error message and fallback", () => {
    expect(errorMessage({ data: { message: "boom" } }, "fallback")).toBe("boom")
    expect(errorMessage(new Error("broken"), "fallback")).toBe("broken")
    expect(errorMessage("unknown", "fallback")).toBe("fallback")
  })
})

describe("workspacePathAliases", () => {
  test("treats macOS /tmp and /private/tmp as the same workspace", () => {
    expect(sameWorkspacePath("/tmp/opencode-rail-test-2", "/private/tmp/opencode-rail-test-2")).toBe(true)
    expect(workspacePathAliases("/tmp/opencode-rail-test-2")).toContain("/private/tmp/opencode-rail-test-2")
    expect(workspacePathAliases("/private/tmp/opencode-rail-test-2")).toContain("/tmp/opencode-rail-test-2")
  })

  test("treats macOS /var and /private/var as the same workspace", () => {
    expect(sameWorkspacePath("/var/folders/xx/project", "/private/var/folders/xx/project")).toBe(true)
  })

  test("does not conflate unrelated paths", () => {
    expect(sameWorkspacePath("/tmp/a", "/tmp/b")).toBe(false)
    expect(sameWorkspacePath("/Users/me/app", "/tmp/app")).toBe(false)
  })
})
