import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { serveMathMcp, verifierFromEnv } from "@/math/mcp"
import { ensureMathWorker, runWorkerLoop, startMathWorker, statusMathWorker, stopMathWorker } from "@/math/worker"
import { mathRoot } from "@/math/layout"
import { migrateLegacyMathProject } from "@/math/migrate"
import { buildVerifierPrompt, parseVerifierText, readVerifyInput } from "@/math/verifier"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { Effect } from "effect"
import { existsSync, readFileSync } from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { ensureMathProblemIdentity, readMathProblemIdentity } from "@/math/identity"
import { computeFactId } from "@/math/schema"
import { readSwarm } from "@/math/swarm"

const log = Log.create({ service: "math.verify.command" })

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
      .command(MathMigrateCommand)
      .command(MathOwnershipCommand)
      .command(MathStartCommand)
      .command(MathEnsureCommand)
      .command(MathStatusCommand)
      .command(MathStopCommand)
      .demandCommand(),
  async handler() {},
})

export const MathMigrateCommand = cmd({
  command: "migrate",
  describe: "copy one legacy .math/<name> store into an isolated problem workspace",
  builder: (yargs) =>
    yargs
      .option("source", {
        type: "string",
        demandOption: true,
        describe: "legacy project name directly under .math/",
      })
      .option("problem", {
        type: "string",
        demandOption: true,
        describe: "new problem ID under .math/problems/",
      })
      .option("dir", {
        type: "string",
        describe: "workspace containing the legacy .math directory (default: cwd)",
      }),
  handler(args) {
    const workspace = args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd()
    const result = migrateLegacyMathProject({
      workspace,
      source: args.source,
      problem: args.problem,
    })
    process.stdout.write(JSON.stringify(result) + "\n")
  },
})

export const MathOwnershipCommand = effectCmd({
  command: "ownership",
  describe: "verify and optionally register legacy MathProblem ownership",
  directory: (args: { "owner-dir": string }) => path.resolve(process.cwd(), args["owner-dir"]),
  runtimeDirectory: (args: { dir: string }) => path.resolve(process.cwd(), args.dir),
  builder: (yargs: Argv) =>
    yargs
      .option("dir", { type: "string", demandOption: true, describe: "legacy MathProblem workspace" })
      .option("owner-dir", { type: "string", demandOption: true, describe: "owning project directory" })
      .option("parent", { type: "string", demandOption: true, describe: "owning orchestrator session ID" })
      .option("worker", { type: "string", demandOption: true, describe: "worker session listed in swarm.json" })
      .option("apply", { type: "boolean", default: false, describe: "write ownership.json after validation" }),
  handler: Effect.fn("Cli.math.ownership")(function* (args) {
    const ctx = yield* InstanceState.context
    const sessions = yield* Session.Service
    const parent = yield* sessions.get(SessionID.make(args.parent)).pipe(Effect.orDie)
    const worker = yield* sessions.get(SessionID.make(args.worker)).pipe(Effect.orDie)
    const ownerDirectory = path.resolve(process.cwd(), args["owner-dir"])
    const directory = path.resolve(process.cwd(), args.dir)
    const record = readSwarm(directory).workers[worker.id]
    const taskFile = record?.taskFile ? path.resolve(record.taskFile) : undefined
    const taskIsContained =
      taskFile !== undefined && taskFile.startsWith(`${directory}${path.sep}`) && existsSync(taskFile)
    if (
      ctx.project.id !== parent.projectID ||
      path.resolve(parent.directory) !== ownerDirectory ||
      parent.agent !== "math-orchestrator" ||
      worker.agent !== "math-worker" ||
      worker.parentID !== parent.id ||
      worker.projectID !== parent.projectID ||
      record?.parentSessionID !== parent.id ||
      !taskIsContained
    ) {
      return yield* fail("MathProblem ownership evidence does not agree across project, sessions, and swarm roster")
    }

    const existing = readMathProblemIdentity(directory)
    if (existing) {
      if (
        existing.ownerProjectID !== parent.projectID ||
        path.resolve(existing.ownerDirectory) !== ownerDirectory ||
        existing.orchestratorSessionID !== parent.id
      ) {
        return yield* fail("existing MathProblem ownership conflicts with the verified owner")
      }
    }
    log.info("MathProblem legacy ownership evidence verified", {
      ownerProjectID: parent.projectID,
      ownerDirectory,
      orchestratorSessionID: parent.id,
      workerSessionID: worker.id,
      problemID: path.basename(directory),
      directory,
      apply: args.apply === true,
    })
    const result = args.apply
      ? ensureMathProblemIdentity({
          directory,
          ownerProjectID: parent.projectID,
          ownerDirectory,
          orchestratorSessionID: parent.id,
          legacyAdoption: { workerSessionID: worker.id, parentSessionID: parent.id },
        })
      : {
          version: 1,
          problemID: path.basename(directory),
          directory,
          ownerProjectID: parent.projectID,
          ownerDirectory,
          orchestratorSessionID: parent.id,
          legacyAdoption: { workerSessionID: worker.id, parentSessionID: parent.id },
        }
    process.stdout.write(JSON.stringify({ applied: args.apply === true, identity: result }) + "\n")
  }),
})

export const MathVerifyCommand = effectCmd({
  command: "verify",
  describe: false,
  directory: (args: { "owner-dir"?: string }) =>
    args["owner-dir"] ? path.resolve(process.cwd(), args["owner-dir"]) : process.cwd(),
  runtimeDirectory: (args: { dir?: string }) => (args.dir ? path.resolve(process.cwd(), args.dir) : undefined),
  builder: (yargs: Argv) =>
    yargs
      .option("input", { type: "string", demandOption: true, describe: "verifier input JSON file" })
      .option("dir", { type: "string", describe: "workspace directory (Instance cwd)" })
      .option("owner-dir", { type: "string", demandOption: true, describe: "owning user project directory" })
      .option("owner-project", { type: "string", demandOption: true, describe: "owning project ID" })
      .option("parent", { type: "string", demandOption: true, describe: "worker session that submitted the claim" })
      .option("model", { type: "string", describe: "verifier model as provider/model" }),
  handler: Effect.fn("Cli.math.verify")(function* (args) {
    const inputFile = path.resolve(process.cwd(), String(args.input))
    const input = yield* Effect.tryPromise({
      try: () => readVerifyInput(inputFile),
      catch: (error) => new Error(`invalid verifier input: ${error instanceof Error ? error.message : String(error)}`),
    }).pipe(Effect.orDie)
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const ctx = yield* InstanceState.context
    if (ctx.project.id !== args["owner-project"]) return yield* fail("math verifier owner project mismatch")
    const identity = readMathProblemIdentity(ctx.directory)
    if (!identity || identity.ownerProjectID !== ctx.project.id) {
      return yield* fail("math verifier MathProblem ownership could not be validated")
    }
    const worker = yield* sessions.get(SessionID.make(args.parent)).pipe(Effect.orDie)
    if (
      worker.agent !== "math-worker" ||
      worker.projectID !== identity.ownerProjectID ||
      worker.parentID !== identity.orchestratorSessionID ||
      path.resolve(worker.directory) !== path.resolve(identity.directory)
    ) {
      return yield* fail("math verifier parent must be a math-worker owned by the parent project")
    }
    const reviewID = computeFactId({
      problem_id: input.problem_id,
      predecessors: input.predecessors,
      glossary_introduces: input.glossary,
      statement: input.statement,
      proof: input.proof,
    })
    // The prompt loop deliberately refuses to run archived sessions. Keep the
    // verifier live until its one prompt settles, then archive it in the
    // ensuring finalizer below so verifier sessions remain hidden afterwards.
    log.info("creating internal verifier review session", {
      inputFile,
      ownerProjectID: identity.ownerProjectID,
      problemID: identity.problemID,
      parentSessionID: worker.id,
      directory: ctx.directory,
      reviewID,
    })
    const session = yield* sessions.create({
      parentID: worker.id,
      title: `math-verifier ${identity.problemID} ${reviewID}`,
      agent: "math-verifier",
    })
    log.info("internal verifier review session created", {
      sessionID: session.id,
      parentSessionID: worker.id,
      ownerProjectID: session.projectID,
      directory: session.directory,
      reviewID,
      archived: session.time.archived,
    })
    const result = yield* Effect.gen(function* () {
      const modelName = typeof args.model === "string" ? args.model : process.env.OPENCODE_MATH_VERIFY_MODEL
      const model = modelName ? Provider.parseModel(modelName) : undefined
      log.info("starting verifier prompt", {
        sessionID: session.id,
        parentSessionID: worker.id,
        ownerProjectID: identity.ownerProjectID,
        problemID: identity.problemID,
        reviewID,
        model: modelName,
      })
      return yield* prompts.prompt({
        sessionID: session.id,
        agent: "math-verifier",
        model,
        parts: [{ type: "text", text: buildVerifierPrompt(input) }],
      })
    }).pipe(
      Effect.ensuring(sessions.setArchived({ sessionID: session.id, time: Date.now() })),
      Effect.tapCause((cause) =>
        Effect.sync(() =>
          log.error("verifier prompt failed", {
            sessionID: session.id,
            parentSessionID: worker.id,
            ownerProjectID: identity.ownerProjectID,
            problemID: identity.problemID,
            reviewID,
            cause: String(cause),
          }),
        ),
      ),
      Effect.catchCause((cause) => fail(`math verifier session failed: ${String(cause)}`)),
    )
    log.info("verifier prompt completed", {
      sessionID: session.id,
      parentSessionID: worker.id,
      ownerProjectID: identity.ownerProjectID,
      problemID: identity.problemID,
      reviewID,
      role: result.info.role,
      error: result.info.role === "assistant" ? result.info.error : undefined,
    })
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
          "math problem workspace (contains fact_graph/ and global_memory/). Default: OPENCODE_MATH_PROJECT_DIR or cwd/.math/problems/<name>",
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
    const projectDir = args.projectDir || process.env.OPENCODE_MATH_PROJECT_DIR || mathRoot(process.cwd(), "default")
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
  directory: (args: { "owner-dir"?: string }) =>
    args["owner-dir"] ? path.resolve(process.cwd(), args["owner-dir"]) : process.cwd(),
  runtimeDirectory: (args: { dir?: string }) => (args.dir ? path.resolve(process.cwd(), args.dir) : undefined),
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
      .option("owner-dir", { type: "string", demandOption: true, describe: "owning user project directory" })
      .option("owner-project", { type: "string", demandOption: true, describe: "owning project ID" })
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
      .option("generation", {
        type: "number",
        hidden: true,
        describe: "detached worker incarnation used to fence stale processes",
      })
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
    const ownerProjectID = typeof args["owner-project"] === "string" ? args["owner-project"] : undefined
    if (!ownerProjectID || ownerProjectID !== ctx.project.id) {
      return yield* fail("math worker requires a matching explicit owner project")
    }
    const projectDir = resolveMathProjectDir(
      typeof args["project-dir"] === "string" ? args["project-dir"] : undefined,
      ctx.directory,
    )
    const identity = readMathProblemIdentity(projectDir)
    if (
      !identity ||
      identity.ownerProjectID !== ownerProjectID ||
      path.resolve(identity.ownerDirectory) !== path.resolve(ctx.directory)
    ) {
      return yield* fail("math worker MathProblem ownership could not be validated")
    }
    let sessionID = typeof args.session === "string" ? args.session : undefined
    const sessions = yield* Session.Service
    if (!sessionID) {
      if (!args.create) return yield* fail("math worker requires --session or --create")
      if (!args.parent) return yield* fail("math worker --create requires a parent session")
      const parent = yield* sessions.get(SessionID.make(args.parent)).pipe(Effect.orDie)
      if (
        parent.projectID !== identity.ownerProjectID ||
        path.resolve(parent.directory) !== path.resolve(identity.ownerDirectory) ||
        parent.id !== identity.orchestratorSessionID
      ) {
        return yield* fail("math worker parent does not own this MathProblem")
      }
      const session = yield* sessions.create({
        parentID: parent.id,
        title: "math-worker",
        agent: "math-worker",
      })
      sessionID = session.id
      process.stderr.write(`created session ${sessionID}\n`)
    }
    const worker = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
    if (
      worker.agent !== "math-worker" ||
      worker.projectID !== ownerProjectID ||
      worker.parentID !== identity.orchestratorSessionID
    ) {
      return yield* fail("math worker session is not owned by the declared parent project")
    }
    log.info("math worker execution context validated", {
      ownerProjectID,
      ownerDirectory: ctx.project.worktree,
      parentSessionID: worker.parentID,
      sessionID,
      problemID: identity.problemID,
      directory: projectDir,
    })
    const interval = typeof args.interval === "number" && args.interval > 0 ? args.interval : 2000
    yield* runWorkerLoop({
      sessionID,
      projectDir,
      intervalMs: interval,
      heartbeatOnly: args["probe-heartbeat-only"] === true,
      model: typeof args.model === "string" ? args.model : process.env.OPENCODE_MATH_WORKER_MODEL,
      variant: typeof args.variant === "string" ? args.variant : undefined,
      generation: typeof args.generation === "number" ? args.generation : undefined,
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
      .option("project", { type: "string", describe: "math problem ID under .math/problems/" })
      .option("problem-file", { type: "string", describe: "file whose contents are persisted verbatim as PROBLEM.md" })
      .option("interval", { type: "number", describe: "heartbeat interval ms" })
      .option("model", { type: "string", describe: "worker model as provider/model" })
      .option("variant", { type: "string", describe: "worker model effort/variant" }),
  handler: Effect.fn("Cli.math.start")(function* (args) {
    const result = yield* startMathWorker({
      parentSessionID: SessionID.make(args.parent),
      title: args.title || "math-worker",
      task: args.task || "# TASK\n",
      project: args.project,
      problem: args["problem-file"] ? readFileSync(args["problem-file"], "utf8") : undefined,
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
