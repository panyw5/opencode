import { Effect } from "effect"
import { ProjectAlias } from "./alias"
import type { ProjectLocationKind, ProjectLocationVcsState } from "./location.sql"

export interface CommandResult {
  code: number
  text: string
  stderr: string
}

export interface RepositoryEvidence {
  headState: "unborn" | "ready"
  rootCommits: string[]
  remoteUrl?: string
}

export const collectRepository = Effect.fn("GitEvidence.collectRepository")(function* (input: {
  cwd: string
  run: (args: string[], options: { cwd: string }) => Effect.Effect<CommandResult>
}) {
  const [remote, rootsResult] = yield* Effect.all(
    [
      input.run(["remote", "get-url", "origin"], { cwd: input.cwd }),
      input.run(["rev-list", "--max-parents=0", "HEAD"], { cwd: input.cwd }),
    ],
    { concurrency: 2 },
  )
  const rootCommits = rootsResult.text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .toSorted()
  return {
    headState: rootCommits[0] ? "ready" : "unborn",
    rootCommits,
    remoteUrl: remote.code === 0 ? ProjectAlias.normalizeRemoteUrl(remote.text) : undefined,
  } satisfies RepositoryEvidence
})

export function vcsState(input: {
  gitDir?: string
  reason: string
  headState?: RepositoryEvidence["headState"]
}): ProjectLocationVcsState {
  if (!input.gitDir) return "none"
  if (input.reason.includes("unavailable")) return "unavailable"
  if (input.reason.includes("error")) return "error"
  return input.headState ?? "error"
}

export function kind(input: {
  gitDir?: string
  locationRoot: string
  worktreeRoot: string
  remoteUrl?: string
}): ProjectLocationKind {
  if (!input.gitDir) return "directory"
  if (input.locationRoot !== input.worktreeRoot) return "git_worktree"
  return input.remoteUrl ? "git_clone" : "git_main"
}

export * as GitEvidence from "./git-evidence"
