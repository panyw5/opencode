import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { serveMathMcp, verifierFromEnv } from "@/math/mcp"
import { ensureMathWorker, runWorkerLoop, startMathWorker, statusMathWorker, stopMathWorker } from "@/math/worker"
import { mathRoot } from "@/math/layout"
import { buildVerifierPrompt, parseVerifierText, readVerifyInput } from "@/math/verifier"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { Effect } from "effect"
import path from "path"

function resolveMathProjectDir(projectDir: string | undefined, workspace: string): string {
  return (
    projectDir || process.env.OPENCODE_MATH_PROJECT_DIR || mathRoot(workspace, path.basename(workspace) || "default")
  )
}

export const MathCommand = cmd({
  command: "math",
  describe: "math mode (fact graph MCP + detached workers)",
  builder: (yargs) =>
    yargs
      .command(MathMcpCommand)
      .command(MathWorkerCommand)
      .command(MathVerifyCommand)
      .command(MathStartCommand)
      .command(MathEnsureCommand)
      .command(MathStatusCommand)
      .command(MathStopCommand)
      .demandCommand(),
  async handler() {},
})

export const MathVerifyCommand = effectCmd({
  command: "verify",
  describe: false,
  directory: (args: { dir?: string }) => (args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .option("input", { type: "string", demandOption: true, describe: "verifier input JSON file" })
      .option("dir", { type: "string", describe: "workspace directory (Instance cwd)" })
      .option("model", { type: "string", describe: "verifier model as provider/model" }),
  handler: Effect.fn("Cli.math.verify")(function* (args) {
    const inputFile = path.resolve(process.cwd(), String(args.input))
    const input = yield* Effect.tryPromise({
      try: () => readVerifyInput(inputFile),
      catch: (error) => new Error(`invalid verifier input: ${error instanceof Error ? error.message : String(error)}`),
    }).pipe(Effect.orDie)
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const session = yield* sessions.create({ title: "math-verifier", agent: "math-verifier" })
    const modelName = typeof args.model === "string" ? args.model : process.env.OPENCODE_MATH_VERIFY_MODEL
    const model = modelName ? Provider.parseModel(modelName) : undefined
    const result = yield* prompts
      .prompt({
        sessionID: session.id,
        agent: "math-verifier",
        model,
        parts: [{ type: "text", text: buildVerifierPrompt(input) }],
      })
      .pipe(
        Effect.ensuring(sessions.setArchived({ sessionID: session.id, time: Date.now() })),
        Effect.catchCause((cause) => fail(`math verifier session failed: ${String(cause)}`)),
      )
    if (result.info.role !== "assistant" || result.info.error) {
      const detail = result.info.role === "assistant" ? JSON.stringify(result.info.error) : "no assistant response"
      return yield* fail(`math verifier session failed: ${detail}`)
    }
    let verdict
    try {
      const text = result.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
      verdict = parseVerifierText(text)
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error))
    }
    process.stdout.write(JSON.stringify(verdict) + "\n")
  }),
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
        describe:
          "math project root (contains fact_graph/ and global_memory/). Default: OPENCODE_MATH_PROJECT_DIR or cwd/.math/<name>",
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
  describe: "run a detached math-worker prompt loop (does not follow sidecar lifetime)",
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
      .option("model", {
        type: "string",
        describe: "worker model as provider/model (or OPENCODE_MATH_WORKER_MODEL)",
      })
      .option("variant", { type: "string", describe: "worker model effort/variant" })
      .option("parent", {
        type: "string",
        describe: "parent session id when --create is set",
      })
      .option("probe-heartbeat-only", {
        type: "boolean",
        default: false,
        hidden: true,
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
      heartbeatOnly: args["probe-heartbeat-only"] === true,
      model: typeof args.model === "string" ? args.model : process.env.OPENCODE_MATH_WORKER_MODEL,
      variant: typeof args.variant === "string" ? args.variant : undefined,
    }).pipe(Effect.catchCause((cause) => fail(`math worker loop failed: ${String(cause)}`)))
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
      .option("interval", { type: "number", describe: "heartbeat interval ms" })
      .option("model", { type: "string", describe: "worker model as provider/model" })
      .option("variant", { type: "string", describe: "worker model effort/variant" }),
  handler: Effect.fn("Cli.math.start")(function* (args) {
    const result = yield* startMathWorker({
      parentSessionID: SessionID.make(args.parent),
      title: args.title || "math-worker",
      task: args.task || "# TASK\n",
      project: args.project,
      intervalMs: args.interval,
      model: args.model,
      variant: args.variant,
    })
    process.stdout.write(JSON.stringify(result) + "\n")
  }),
})

export const MathEnsureCommand = effectCmd({
  command: "ensure",
  describe: "restart a dead math-worker using the same session id",
  builder: (yargs) =>
    yargs
      .option("session", { type: "string", demandOption: true, describe: "existing math-worker session id" })
      .option("project-dir", { type: "string", describe: "existing math project root" })
      .option("interval", { type: "number", describe: "worker round interval ms" })
      .option("model", { type: "string", describe: "worker model as provider/model" })
      .option("variant", { type: "string", describe: "worker model effort/variant" }),
  handler: Effect.fn("Cli.math.ensure")(function* (args) {
    const ctx = yield* InstanceState.context
    const projectDir = resolveMathProjectDir(args["project-dir"], ctx.directory)
    const result = yield* ensureMathWorker({
      sessionID: SessionID.make(args.session),
      projectDir,
      intervalMs: args.interval,
      model: args.model,
      variant: args.variant,
    }).pipe(Effect.catchCause((cause) => fail(`math worker ensure failed: ${String(cause)}`)))
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
  describe: "stop a math-worker process group (SIGTERM; --force uses SIGKILL)",
  builder: (yargs) =>
    yargs
      .option("session", { type: "string", demandOption: true, describe: "worker session id" })
      .option("force", { type: "boolean", default: false, describe: "use SIGKILL instead of SIGTERM" })
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
