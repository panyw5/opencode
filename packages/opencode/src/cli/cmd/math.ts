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
import { existsSync, lstatSync, readFileSync, realpathSync } from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { checkMathWorkerOwnership, ensureMathProblemIdentity, readMathProblemIdentity } from "@/math/identity"
import { computeFactId } from "@/math/schema"
import { readSwarm } from "@/math/swarm"
import { resolveExistingMathWorkspaceFromSessions, resolveMathWorkerBootstrap } from "@/math/workspace"
import { assertMathPathWithin, isMathPathWithin } from "@/math/workspace"

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
    const canonical = (value: string) => {
      try {
        return realpathSync.native(value)
      } catch {
        return path.resolve(value)
      }
    }
    const record = readSwarm(directory).workers[worker.id]
    const existing = readMathProblemIdentity(directory)
    const taskFile = record?.taskFile ? path.resolve(record.taskFile) : undefined
    let taskIsContained = false
    try {
      if (taskFile && existsSync(taskFile) && !lstatSync(taskFile).isSymbolicLink()) {
        assertMathPathWithin(directory, taskFile, "Math ownership TASK")
        taskIsContained = isMathPathWithin(canonical(directory), canonical(taskFile))
      }
      assertMathPathWithin(path.join(ownerDirectory, ".math"), directory, "Math ownership managed directory")
      if (!isMathPathWithin(canonical(ownerDirectory), canonical(directory))) taskIsContained = false
    } catch {
      taskIsContained = false
    }
    const workerDirectory = canonical(worker.directory)
    const targetDirectory = canonical(directory)
    const legacyAuthorized =
      workerDirectory === canonical(parent.directory) &&
      (!existing || existing.legacyAdoption?.workerSessionID === worker.id)
    const workerDirectoryValid = workerDirectory === targetDirectory || legacyAuthorized
    if (
      ctx.project.id !== parent.projectID ||
      canonical(parent.directory) !== canonical(ownerDirectory) ||
      parent.agent !== "math-orchestrator" ||
      worker.agent !== "math-worker" ||
      worker.parentID !== parent.id ||
      worker.projectID !== parent.projectID ||
      record?.parentSessionID !== parent.id ||
      !taskIsContained
      || !workerDirectoryValid
    ) {
      return yield* fail("MathProblem ownership evidence does not agree across project, sessions, and swarm roster")
    }

    if (existing) {
      if (
        existing.ownerProjectID !== parent.projectID ||
        canonical(existing.ownerDirectory) !== canonical(ownerDirectory) ||
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
  directory: (args: { "owner-dir"?: string; parent?: string }) => {
    if (args.parent) return resolveMathWorkerBootstrap(args.parent).ownerDirectory
    return args["owner-dir"] ? path.resolve(process.cwd(), args["owner-dir"]) : process.cwd()
  },
  runtimeDirectory: (args: { dir?: string; parent?: string }) => {
    if (args.parent) return resolveMathWorkerBootstrap(args.parent).problemDirectory
    return args.dir ? path.resolve(process.cwd(), args.dir) : undefined
  },
  builder: (yargs: Argv) =>
    yargs
      .option("input", { type: "string", demandOption: true, describe: "verifier input JSON file" })
      .option("dir", { type: "string", describe: "workspace directory (Instance cwd)" })
      .option("owner-dir", { type: "string", describe: "owning user project directory (legacy assertion)" })
      .option("owner-project", { type: "string", describe: "owning project ID (legacy assertion)" })
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
    if (args["owner-project"] && ctx.project.id !== args["owner-project"]) {
      return yield* fail("math verifier owner project mismatch")
    }
    const identity = readMathProblemIdentity(ctx.directory)
    if (!identity || identity.ownerProjectID !== ctx.project.id) {
      return yield* fail("math verifier MathProblem ownership could not be validated")
    }
    const worker = yield* sessions.get(SessionID.make(args.parent)).pipe(Effect.orDie)
    const workspace = worker.parentID
      ? yield* resolveExistingMathWorkspaceFromSessions({
          sessions,
          parentSessionID: worker.parentID,
          workerSessionID: worker.id,
          problemID: path.basename(ctx.directory),
        }).pipe(Effect.orDie)
      : undefined
    if (
      worker.agent !== "math-worker" ||
      worker.projectID !== identity.ownerProjectID ||
      worker.parentID !== identity.orchestratorSessionID ||
      !workspace || path.resolve(workspace.problemDirectory) !== path.resolve(identity.directory)
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
    let projectDir = args.projectDir || process.env.OPENCODE_MATH_PROJECT_DIR || mathRoot(process.cwd(), "default")
    let author = args.author || process.env.OPENCODE_MATH_AUTHOR || "unknown"
    let problemId = args.problemId || process.env.OPENCODE_MATH_PROBLEM_ID || path.basename(projectDir)
    if ((args.role || process.env.OPENCODE_MATH_ROLE) === "worker" && author === "unknown") {
      throw new Error("worker math mcp requires --author/OPENCODE_MATH_AUTHOR")
    }
    if ((args.role || process.env.OPENCODE_MATH_ROLE) === "worker") {
      const bootstrap = resolveMathWorkerBootstrap(author, args.projectDir ? path.resolve(process.cwd(), args.projectDir) : undefined)
      if (args.projectDir && path.resolve(process.cwd(), args.projectDir) !== bootstrap.problemDirectory) {
        throw new Error("math mcp --project-dir does not match the worker session workspace")
      }
      if (args.problemId && args.problemId !== bootstrap.problemID) throw new Error("math mcp --problem-id mismatch")
      projectDir = bootstrap.problemDirectory
      author = bootstrap.workerSessionID
      problemId = bootstrap.problemID
    }
    await serveMathMcp({
      projectDir,
      role: args.role || process.env.OPENCODE_MATH_ROLE || "verifier",
      author,
      problemId,
      verifier: verifierFromEnv(),
    })
  },
})

export const MathWorkerCommand = effectCmd({
  command: "worker",
  describe: "run a detached math-worker prompt loop (does not follow sidecar lifetime)",
  directory: (args: { "owner-dir"?: string; session?: string }) => {
    if (args.session) {
      return resolveMathWorkerBootstrap(args.session).ownerDirectory
    }
    return args["owner-dir"] ? path.resolve(process.cwd(), args["owner-dir"]) : process.cwd()
  },
  runtimeDirectory: (args: { dir?: string; session?: string; "project-dir"?: string }) => {
    if (args.session)
      return resolveMathWorkerBootstrap(
        args.session,
        args["project-dir"] ? path.resolve(process.cwd(), args["project-dir"]) : undefined,
      ).problemDirectory
    return args.dir ? path.resolve(process.cwd(), args.dir) : undefined
  },
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
      .option("owner-dir", { type: "string", describe: "owning user project directory (legacy assertion)" })
      .option("owner-project", { type: "string", describe: "owning project ID (legacy assertion)" })
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
    const bootstrap =
      typeof args.session === "string" && !args.create
        ? resolveMathWorkerBootstrap(
            args.session,
            typeof args["project-dir"] === "string" ? path.resolve(process.cwd(), args["project-dir"]) : undefined,
          )
        : undefined
    const ownerProjectID = bootstrap?.ownerProjectID ?? (typeof args["owner-project"] === "string" ? args["owner-project"] : undefined)
    const ownerDirectory =
      bootstrap?.ownerDirectory ?? (typeof args["owner-dir"] === "string" ? path.resolve(process.cwd(), args["owner-dir"]) : undefined)
    log.info("math worker startup context resolved", {
      sessionID: args.session,
      contextProjectID: ctx.project.id,
      runtimeDirectory: ctx.directory,
      ownerProjectID,
      ownerDirectory,
      projectDirArg: args["project-dir"],
      runtimeDirectoryArg: args.dir,
    })
    if (!ownerProjectID || ownerProjectID !== ctx.project.id) {
      return yield* fail("math worker requires a matching explicit owner project")
    }
    if (!ownerDirectory) return yield* fail("math worker requires an explicit owner directory")
    if (bootstrap) {
      if (args["owner-project"] && args["owner-project"] !== bootstrap.ownerProjectID)
        return yield* fail("legacy --owner-project does not match the session owner")
      if (
        args["owner-dir"] &&
        realpathSync(path.resolve(process.cwd(), args["owner-dir"])) !== realpathSync(bootstrap.ownerDirectory)
      )
        return yield* fail("legacy --owner-dir does not match the session owner")
      if (args["project-dir"] && path.resolve(process.cwd(), args["project-dir"]) !== bootstrap.problemDirectory)
        return yield* fail("legacy --project-dir does not match the session problem")
      if (args.dir && path.resolve(process.cwd(), args.dir) !== bootstrap.runtimeDirectory)
        return yield* fail("legacy --dir does not match the session runtime directory")
    }
    const projectDir = bootstrap?.problemDirectory ?? resolveMathProjectDir(
      typeof args["project-dir"] === "string" ? args["project-dir"] : undefined,
      ctx.directory,
    )
    const identity = readMathProblemIdentity(projectDir)
    const ownership = checkMathWorkerOwnership({
      identity,
      projectDir,
      ownerDirectory,
      ownerProjectID,
      runtimeDirectory: ctx.directory,
      projectRuntimeRequired: typeof args.dir === "string",
    })
    log.info("math worker ownership checked", {
      sessionID: args.session,
      projectDir,
      recordOwnerProjectID: identity?.ownerProjectID,
      recordOwnerDirectory: identity?.ownerDirectory,
      recordProjectDir: identity?.directory,
      ...ownership,
    })
    if (!identity || !ownership.valid) {
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
    log.info("math worker session loaded", {
      sessionID,
      agent: worker.agent,
      projectID: worker.projectID,
      parentSessionID: worker.parentID,
      directory: worker.directory,
    })
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
  directory: (args: { session: string; "project-dir"?: string; interval?: number; model?: string; variant?: string }) => resolveMathWorkerBootstrap(args.session).ownerDirectory,
  runtimeDirectory: (args: { session: string; "project-dir"?: string; interval?: number; model?: string; variant?: string }) =>
    resolveMathWorkerBootstrap(args.session, args["project-dir"] ? path.resolve(process.cwd(), args["project-dir"]) : undefined)
      .problemDirectory,
  builder: (yargs) =>
    yargs
      .option("session", { type: "string", demandOption: true, describe: "existing math-worker session id" })
      .option("project-dir", { type: "string", describe: "existing math project root" })
      .option("interval", { type: "number", describe: "worker round interval ms" })
      .option("model", { type: "string", describe: "worker model as provider/model" })
      .option("variant", { type: "string", describe: "worker model effort/variant" }),
  handler: Effect.fn("Cli.math.ensure")(function* (args) {
    const ctx = yield* InstanceState.context
    const bootstrap = resolveMathWorkerBootstrap(
      args.session,
      args["project-dir"] ? path.resolve(process.cwd(), args["project-dir"]) : undefined,
    )
    const projectDir = bootstrap.problemDirectory
    if (args["project-dir"] && path.resolve(process.cwd(), args["project-dir"]) !== projectDir) {
      return yield* fail("legacy --project-dir does not match the worker session workspace")
    }
    const result = yield* ensureMathWorker({
      sessionID: SessionID.make(args.session),
      projectDir,
      ownerDirectory: bootstrap.ownerDirectory,
      ownerProjectID: bootstrap.ownerProjectID,
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
  directory: (args: { session?: string; "project-dir"?: string; parent?: string }) =>
    args.session ? resolveMathWorkerBootstrap(args.session).ownerDirectory : process.cwd(),
  runtimeDirectory: (args: { session?: string; "project-dir"?: string; parent?: string }) =>
    args.session
      ? resolveMathWorkerBootstrap(args.session, args["project-dir"] ? path.resolve(process.cwd(), args["project-dir"]) : undefined)
          .problemDirectory
      : undefined,
  builder: (yargs) =>
    yargs
      .option("session", { type: "string", describe: "filter by worker session id" })
      .option("parent", { type: "string", describe: "filter by parent session id" })
      .option("project-dir", { type: "string" }),
  handler: Effect.fn("Cli.math.status")(function* (args) {
    const ctx = yield* InstanceState.context
    const projectDir = args.session
      ? resolveMathWorkerBootstrap(
          args.session,
          args["project-dir"] ? path.resolve(process.cwd(), args["project-dir"]) : undefined,
        ).problemDirectory
      : resolveMathProjectDir(args["project-dir"], ctx.directory)
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
  directory: (args: { session: string; "project-dir"?: string; force?: boolean }) => resolveMathWorkerBootstrap(args.session).ownerDirectory,
  runtimeDirectory: (args: { session: string; "project-dir"?: string; force?: boolean }) =>
    resolveMathWorkerBootstrap(args.session, args["project-dir"] ? path.resolve(process.cwd(), args["project-dir"]) : undefined)
      .problemDirectory,
  builder: (yargs) =>
    yargs
      .option("session", { type: "string", demandOption: true, describe: "worker session id" })
      .option("force", { type: "boolean", default: false, describe: "use SIGKILL instead of SIGTERM" })
      .option("project-dir", { type: "string" }),
  handler: Effect.fn("Cli.math.stop")(function* (args) {
    const ctx = yield* InstanceState.context
    const projectDir = resolveMathWorkerBootstrap(
      args.session,
      args["project-dir"] ? path.resolve(process.cwd(), args["project-dir"]) : undefined,
    ).problemDirectory
    const result = stopMathWorker({
      projectDir,
      sessionID: args.session,
      force: args.force,
    })
    process.stdout.write(JSON.stringify(result) + "\n")
  }),
})
