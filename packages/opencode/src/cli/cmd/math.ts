import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { serveMathMcp, verifierFromEnv } from "@/math/mcp"
import { runWorkerLoop, startMathWorker, statusMathWorker, stopMathWorker } from "@/math/worker"
import { mathRoot } from "@/math/layout"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { Effect } from "effect"
import path from "path"

function resolveMathProjectDir(projectDir: string | undefined, workspace: string): string {
  return projectDir || process.env.OPENCODE_MATH_PROJECT_DIR || mathRoot(workspace, path.basename(workspace) || "default")
}

export const MathCommand = cmd({
  command: "math",
  describe: "math mode (fact graph MCP + detached workers)",
  builder: (yargs) =>
    yargs
      .command(MathMcpCommand)
      .command(MathWorkerCommand)
      .command(MathStartCommand)
      .command(MathStatusCommand)
      .command(MathStopCommand)
      .demandCommand(),
  async handler() {},
})

export const MathMcpCommand = cmd({
  command: "mcp",
  describe: "run the math truth MCP server over stdio",
  builder: (yargs) =>
    yargs
      .option("role", {
        type: "string",
        choices: ["worker", "orchestrator", "verifier", "all", "main"] as const,
        describe: "which tools this process may expose (unset/unknown = verifier, fail-closed)",
      })
      .option("project-dir", {
        type: "string",
        describe: "math project root (contains fact_graph/ and global_memory/). Default: OPENCODE_MATH_PROJECT_DIR or cwd/.math/<name>",
      })
      .option("author", {
        type: "string",
        describe: "attribution id written on gm_add / fact_submit",
      })
      .option("problem-id", {
        type: "string",
        describe: "problem_id stamped on written facts",
      }),
  async handler(args) {
    const projectDir =
      args.projectDir || process.env.OPENCODE_MATH_PROJECT_DIR || path.join(process.cwd(), ".math", "default")
    await serveMathMcp({
      projectDir,
      role: args.role || process.env.OPENCODE_MATH_ROLE || "verifier",
      author: args.author || process.env.OPENCODE_MATH_AUTHOR || "unknown",
      problemId: args.problemId || process.env.OPENCODE_MATH_PROBLEM_ID || path.basename(projectDir),
      verifier: verifierFromEnv(),
    })
  },
})

export const MathWorkerCommand = effectCmd({
  command: "worker",
  describe: "run a detached math-worker loop (heartbeat; does not follow sidecar lifetime)",
  directory: (args: { dir?: string }) => (args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .option("session", {
        type: "string",
        describe: "existing session id to write into",
      })
      .option("create", {
        type: "boolean",
        default: false,
        describe: "create a new math-worker session if --session is omitted",
      })
      .option("project-dir", {
        type: "string",
        describe: "math project root for swarm.json / .stop / logs",
      })
      .option("dir", {
        type: "string",
        describe: "workspace directory (Instance cwd)",
      })
      .option("interval", {
        type: "number",
        default: 2000,
        describe: "heartbeat interval in milliseconds",
      })
      .option("parent", {
        type: "string",
        describe: "parent session id when --create is set",
      }),
  handler: Effect.fn("Cli.math.worker")(function* (args) {
    const ctx = yield* InstanceState.context
    const projectDir = resolveMathProjectDir(
      typeof args["project-dir"] === "string" ? args["project-dir"] : undefined,
      ctx.directory,
    )
    let sessionID = typeof args.session === "string" ? args.session : undefined
    if (!sessionID) {
      if (!args.create) return yield* fail("math worker requires --session or --create")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        parentID: typeof args.parent === "string" ? SessionID.make(args.parent) : undefined,
        title: "math-worker",
        agent: "math-worker",
      })
      sessionID = session.id
      process.stderr.write(`created session ${sessionID}\n`)
    }
    const interval = typeof args.interval === "number" && args.interval > 0 ? args.interval : 2000
    yield* runWorkerLoop({
      sessionID,
      projectDir,
      intervalMs: interval,
    }).pipe(Effect.catchTag("NotFoundError", (error) => fail(error.message)))
  }),
})

export const MathStartCommand = effectCmd({
  command: "start",
  describe: "create a math-worker session and spawn it detached",
  builder: (yargs) =>
    yargs
      .option("title", { type: "string", default: "math-worker", describe: "child session title" })
      .option("task", { type: "string", default: "", describe: "TASK.md body" })
      .option("parent", { type: "string", demandOption: true, describe: "parent (orchestrator) session id" })
      .option("project", { type: "string", describe: "math project name under .math/" })
      .option("interval", { type: "number", describe: "heartbeat interval ms" }),
  handler: Effect.fn("Cli.math.start")(function* (args) {
    const result = yield* startMathWorker({
      parentSessionID: SessionID.make(args.parent),
      title: args.title || "math-worker",
      task: args.task || "# TASK\n",
      project: args.project,
      intervalMs: args.interval,
    })
    process.stdout.write(JSON.stringify(result) + "\n")
  }),
})

export const MathStatusCommand = effectCmd({
  command: "status",
  describe: "list math-worker pid / alive / last heartbeat",
  builder: (yargs) =>
    yargs
      .option("session", { type: "string", describe: "filter by worker session id" })
      .option("parent", { type: "string", describe: "filter by parent session id" })
      .option("project-dir", { type: "string" }),
  handler: Effect.fn("Cli.math.status")(function* (args) {
    const ctx = yield* InstanceState.context
    const projectDir = resolveMathProjectDir(args["project-dir"], ctx.directory)
    const rows = statusMathWorker({
      projectDir,
      sessionID: args.session,
      parentSessionID: args.parent,
    })
    process.stdout.write(JSON.stringify(rows) + "\n")
  }),
})

export const MathStopCommand = effectCmd({
  command: "stop",
  describe: "stop a math-worker (write .stop; --force kills the process group)",
  builder: (yargs) =>
    yargs
      .option("session", { type: "string", demandOption: true, describe: "worker session id" })
      .option("force", { type: "boolean", default: false, describe: "killpg SIGKILL" })
      .option("project-dir", { type: "string" }),
  handler: Effect.fn("Cli.math.stop")(function* (args) {
    const ctx = yield* InstanceState.context
    const projectDir = resolveMathProjectDir(args["project-dir"], ctx.directory)
    const result = stopMathWorker({
      projectDir,
      sessionID: args.session,
      force: args.force,
    })
    process.stdout.write(JSON.stringify(result) + "\n")
  }),
})
