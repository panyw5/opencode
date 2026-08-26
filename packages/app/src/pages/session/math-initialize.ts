export type MathInitializationConfig = {
  project: string
  problem: string
  workerModel: string
  highWorkers: number
  xhighWorkers: number
  controlBeat: boolean
}

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function validMathProjectName(value: string): boolean {
  return PROJECT_NAME_RE.test(value.trim())
}

export function defaultMathProjectName(directory: string): string {
  const base = directory.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "math-project"
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "")
  return normalized || "math-project"
}

function workerCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(16, Math.floor(value)))
}

export function buildMathInitializationPrompt(input: MathInitializationConfig): string {
  const project = input.project.trim()
  const problem = input.problem.trim()
  const model = input.workerModel.trim()
  const high = workerCount(input.highWorkers)
  const xhigh = workerCount(input.xhighWorkers)
  const total = high + xhigh
  const roster = [
    high > 0 ? `${high} worker${high === 1 ? "" : "s"} with variant high` : undefined,
    xhigh > 0 ? `${xhigh} worker${xhigh === 1 ? "" : "s"} with variant xhigh` : undefined,
  ]
    .filter(Boolean)
    .join(" and ")

  return [
    "Use the math-initialize skill to initialize or reconnect this Math Mode project.",
    "",
    `Math project: ${project}`,
    "",
    "Problem:",
    problem,
    "",
    "Initialization contract:",
    "- Call math_worker_status before creating anything and reconnect existing durable worker sessions.",
    "- Do not create duplicate workers. Prefer math_worker_ensure for unexpectedly dead workers.",
    `- The user confirmed a bounded roster of ${total} worker${total === 1 ? "" : "s"}: ${roster}.`,
    `- Use worker model ${model} for every new worker, with the variants specified above.`,
    "- Decompose the problem into precise, non-overlapping evidence workstreams.",
    "- Only verifier-backed fact_id values are proof bricks; global memory and worker reports remain hypotheses.",
    "- Do not run mathematical experiments with executable code.",
    input.controlBeat
      ? "- After listing existing scheduled tasks, create one 30-minute control beat in existing_session mode if none exists."
      : "- Do not create a scheduled control beat.",
    "- Report the final roster, durable session IDs, models, variants, and where to monitor the swarm.",
  ].join("\n")
}
