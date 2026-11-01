import type { Prompt, ContextItem } from "../../context/prompt"
import type { SessionBarDraft, SessionBarTab } from "../../context/layout"

/** Every call is an independent synthetic profile; never read the user's storage here. */
export function legacyRuntimeFixture() {
  const legacy = "~/apps/opencode" as const
  const canonical = "/Users/lelouch/apps/opencode" as const
  const parent = "/Users/lelouch/apps" as const
  const draftID = "draft_runtime_qa"
  const sessionID = "ses_runtime_qa"
  return {
    legacy,
    canonical,
    parent,
    draftID,
    sessionID,
    server: {
      list: [],
      projects: {
        local: [
          { worktree: legacy, expanded: true },
          { worktree: canonical, expanded: false },
          { worktree: parent, expanded: true },
        ],
      },
      lastProject: { local: legacy },
    },
    preferences: {
      [legacy]: { name: "Legacy project", color: "blue", expanded: true },
      [canonical]: { name: "Canonical project", color: "green", expanded: false },
    },
    route: { directory: parent, id: sessionID },
    layout: {
      sidebar: { workspaces: { [legacy]: true, [parent]: false } },
      sessionBar: {
        all: [{ directory: legacy, id: sessionID, title: "Synthetic conversation" }] satisfies SessionBarTab[],
        drafts: [{ directory: legacy, id: draftID }] satisfies SessionBarDraft[],
      },
    },
    prompt: {
      directory: legacy,
      id: draftID,
      prompt: [{ type: "text", content: "Unsent synthetic draft", start: 0, end: 21 }] satisfies Prompt,
      context: {
        items: [{ type: "file", path: `${legacy}/README.md` }] satisfies ContextItem[],
      },
    },
    caches: {
      [legacy]: { path: { directory: canonical }, sessions: [{ id: sessionID, directory: canonical }] },
      [parent]: { path: { directory: parent }, sessions: [{ id: "ses_parent_qa", directory: parent }] },
    },
    backends: [
      { url: "http://127.0.0.1:4096", directory: canonical, sessionID },
      { url: "http://127.0.0.1:5096", directory: canonical, sessionID },
    ],
  }
}

/** A manually released port avoids using wall-clock delays to establish ordering. */
export function deferredPort<Input, Output>() {
  const calls: Array<{ input: Input; resolve(value: Output): void; reject(reason: unknown): void }> = []
  return {
    calls,
    run(input: Input) {
      return new Promise<Output>((resolve, reject) => calls.push({ input, resolve, reject }))
    },
  }
}
