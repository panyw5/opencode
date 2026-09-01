import path from "path"

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function assertProjectName(name: string): string {
  if (!PROJECT_NAME_RE.test(name)) throw new Error(`invalid project name: ${JSON.stringify(name)}`)
  return name
}

/** `<workspace>/.math/problems` — container for isolated Math Mode problems. */
export function mathProblemsRoot(workspace: string): string {
  return path.join(workspace, ".math", "problems")
}

/** `<workspace>/.math/<project>` — read-only compatibility path for pre-isolation stores. */
export function legacyMathRoot(workspace: string, project: string): string {
  const name = assertProjectName(project)
  if (name === "problems") throw new Error("the .math/problems directory is not a legacy math project")
  return path.join(workspace, ".math", name)
}

/** `<workspace>/.math/problems/<problem>` — one isolated Math Mode problem workspace. */
export function mathRoot(workspace: string, problem: string): string {
  return path.join(mathProblemsRoot(workspace), assertProjectName(problem))
}

export type MathLayout = {
  root: string
  problem: string
  tasks: string
  globalMemory: string
  factGraph: string
  facts: string
  revoked: string
  glossary: string
  revocationLog: string
  swarm: string
  logs: string
}

export function layout(root: string): MathLayout {
  const factGraph = path.join(root, "fact_graph")
  return {
    root,
    problem: path.join(root, "PROBLEM.md"),
    tasks: path.join(root, "TASKS"),
    globalMemory: path.join(root, "global_memory"),
    factGraph,
    facts: path.join(factGraph, "facts"),
    revoked: path.join(factGraph, "_revoked"),
    glossary: path.join(factGraph, "glossary.json"),
    revocationLog: path.join(factGraph, "revocation_log.jsonl"),
    swarm: path.join(root, "swarm.json"),
    logs: path.join(root, "logs"),
  }
}

export function taskPath(root: string, sessionID: string): string {
  return path.join(root, "TASKS", `${sessionID}.md`)
}

export * as MathLayout from "./layout"
