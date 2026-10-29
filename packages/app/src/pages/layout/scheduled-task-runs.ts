import type { ScheduledTaskRun } from "@opencode-ai/sdk/v2/client"

export function mergeScheduledTaskRuns(runs: ScheduledTaskRun[], updates: ScheduledTaskRun[], limit = 20) {
  const byID = new Map(runs.map((run) => [run.id, run]))
  for (const run of updates) byID.set(run.id, run)
  return [...byID.values()].sort((a, b) => b.scheduledAt - a.scheduledAt).slice(0, limit)
}
