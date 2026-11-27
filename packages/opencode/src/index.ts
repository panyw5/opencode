import yargs, { type Argv, type CommandModule, type Options } from "yargs"
import { hideBin } from "yargs/helpers"
import type { Level as LogLevel } from "@opencode-ai/core/util/log"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EOL } from "os"
import path from "path"

const lazyLog = () => import("@opencode-ai/core/util/log")

function isResolveMessage(value: unknown): value is {
  name: string
  message: string
  code?: string
  specifier?: string
  referrer?: string
  position?: unknown
  importKind?: string
} {
  return isRecord(value) && value.name === "ResolveMessage" && typeof value.message === "string"
}

process.on("unhandledRejection", (e) => {
  void lazyLog().then((log) =>
    log.Default.error("rejection", {
      e: errorMessage(e),
    }),
  )
})

process.on("uncaughtException", (e) => {
  void lazyLog().then((log) =>
    log.Default.error("exception", {
      e: errorMessage(e),
    }),
  )
})

const args = hideBin(process.argv)

// The `extension-host` worker entrypoint bypasses yargs entirely: the global
// middleware would run Log.init, Heap.start, env injection and the sqlite
// JsonMigration check in a process that must stay a dumb worker
// (specs/extensions/process-isolation-design.md §1.2).
if (args[0] === "extension-host") {
  const { runExtensionHost } = await import("./extension/host-process/entry.ts")
  process.exit(await runExtensionHost(args.slice(1)))
}

const processMetadata = ensureProcessMetadata("main")

let ui: typeof import("./cli/ui").UI | undefined

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    if (ui) process.stderr.write(ui.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

// Commands are registered as thin stubs so `opencode --version` / `--help`
// never pay to evaluate the full command module graph (provider SDKs, server,
// session stack). The real module is imported on first dispatch.
interface LoadedCommand {
  builder?: ((yargs: Argv) => unknown) | Record<string, unknown>
  handler?: (args: never) => unknown
}

function lazy(
  meta: { command: string | readonly string[]; describe?: string | false; aliases?: string | readonly string[] },
  load: () => Promise<LoadedCommand>,
): CommandModule {
  return {
    command: meta.command,
    describe: meta.describe,
    aliases: meta.aliases,
    builder: async (yargs) => {
      const mod = await load()
      if (typeof mod.builder === "function") return (mod.builder(yargs) ?? yargs) as Argv
      if (mod.builder) return yargs.options(mod.builder as { [key: string]: Options })
      return yargs
    },
    handler: async (argv) => {
      const mod = await load()
      await mod.handler?.(argv as never)
    },
  }
}

let cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    const start = Date.now()
    // `Log` must finish evaluating before other module graphs load it as a
    // dependency — a concurrent import() sees its "evaluating" state as a
    // cycle and downstream `Log.create` calls hit the uninitialized binding.
    const Log = await lazyLog()
    const [{ Installation }, { Heap }] = await Promise.all([import("./installation"), import("./cli/heap")])
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as LogLevel
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Heap.start()

    Log.create({ service: "startup" }).info("cli.bootstrap", {
      duration: Date.now() - start,
      print_logs: process.argv.includes("--print-logs"),
      level: opts.logLevel ?? (Installation.isLocal() ? "DEBUG" : "INFO"),
    })

    Log.Default.info("opencode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const { Global } = await import("@opencode-ai/core/global")
    const { Filesystem } = await import("@/util/filesystem")
    const marker = path.join(Global.Path.data, "opencode.db")
    if (!(await Filesystem.exists(marker))) {
      const [{ JsonMigration }, { Database }, { drizzle }] = await Promise.all([
        import("./storage/json-migration"),
        import("./storage/db"),
        import("drizzle-orm/bun-sqlite"),
      ])
      const timer = Log.create({ service: "startup" }).time("sqlite.migration")
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        timer.stop()
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(
    lazy({ command: "acp", describe: "start ACP (Agent Client Protocol) server" }, () =>
      import("./cli/cmd/acp").then((m) => m.AcpCommand),
    ),
  )
  .command(
    lazy({ command: "mcp", describe: "manage MCP (Model Context Protocol) servers" }, () =>
      import("./cli/cmd/mcp").then((m) => m.McpCommand),
    ),
  )
  .command(
    lazy({ command: "extension", describe: "manage OpenCode extensions", aliases: ["ext"] }, () =>
      import("./cli/cmd/extension").then((m) => m.ExtensionCommand),
    ),
  )
  .command(
    lazy({ command: "math", describe: "math mode (fact graph MCP + detached workers)" }, () =>
      import("./cli/cmd/math").then((m) => m.MathCommand),
    ),
  )
  .command(
    lazy({ command: "run [message..]", describe: "run opencode with a message" }, () =>
      import("./cli/cmd/run").then((m) => m.RunCommand),
    ),
  )
  .command(lazy({ command: "generate" }, () => import("./cli/cmd/generate").then((m) => m.GenerateCommand)))
  .command(
    lazy({ command: "debug", describe: "debugging and troubleshooting tools" }, () =>
      import("./cli/cmd/debug").then((m) => m.DebugCommand),
    ),
  )
  .command(
    lazy({ command: "console", describe: false }, () => import("./cli/cmd/account").then((m) => m.ConsoleCommand)),
  )
  .command(
    lazy({ command: "providers", describe: "manage AI providers and credentials", aliases: ["auth"] }, () =>
      import("./cli/cmd/providers").then((m) => m.ProvidersCommand),
    ),
  )
  .command(
    lazy({ command: "agent", describe: "manage agents" }, () => import("./cli/cmd/agent").then((m) => m.AgentCommand)),
  )
  .command(
    lazy({ command: "upgrade [target]", describe: "upgrade opencode to the latest or a specific version" }, () =>
      import("./cli/cmd/upgrade").then((m) => m.UpgradeCommand),
    ),
  )
  .command(
    lazy({ command: "uninstall", describe: "uninstall opencode and remove all related files" }, () =>
      import("./cli/cmd/uninstall").then((m) => m.UninstallCommand),
    ),
  )
  .command(
    lazy({ command: "serve", describe: "starts a headless opencode server" }, () =>
      import("./cli/cmd/serve").then((m) => m.ServeCommand),
    ),
  )
  .command(
    lazy({ command: "web", describe: "start opencode server and open web interface" }, () =>
      import("./cli/cmd/web").then((m) => m.WebCommand),
    ),
  )
  .command(
    lazy({ command: "models [provider]", describe: "list all available models" }, () =>
      import("./cli/cmd/models").then((m) => m.ModelsCommand),
    ),
  )
  .command(
    lazy({ command: "stats", describe: "show token usage and cost statistics" }, () =>
      import("./cli/cmd/stats").then((m) => m.StatsCommand),
    ),
  )
  .command(
    lazy({ command: "export [sessionID]", describe: "export session data as JSON" }, () =>
      import("./cli/cmd/export").then((m) => m.ExportCommand),
    ),
  )
  .command(
    lazy({ command: "import <file>", describe: "import session data from JSON file or URL" }, () =>
      import("./cli/cmd/import").then((m) => m.ImportCommand),
    ),
  )
  .command(
    lazy({ command: "github", describe: "manage GitHub agent" }, () =>
      import("./cli/cmd/github").then((m) => m.GithubCommand),
    ),
  )
  .command(
    lazy({ command: "pr <number>", describe: "fetch and checkout a GitHub PR branch, then run opencode" }, () =>
      import("./cli/cmd/pr").then((m) => m.PrCommand),
    ),
  )
  .command(
    lazy({ command: "session", describe: "manage sessions" }, () =>
      import("./cli/cmd/session").then((m) => m.SessionCommand),
    ),
  )
  .command(
    lazy({ command: "desktop [directory]", describe: "open OpenCode desktop app with specified directory" }, () =>
      import("./cli/cmd/desktop").then((m) => m.DesktopCommand),
    ),
  )
  .command(lazy({ command: "db", describe: "database tools" }, () => import("./cli/cmd/db").then((m) => m.DbCommand)))
  .command(
    lazy({ command: "openclaw-serve", describe: "start an OpenClaw gateway adapter server" }, () =>
      import("./cli/cmd/openclaw-serve").then((m) => m.OpenClawServeCommand),
    ),
  )
  .command(
    lazy({ command: "extra-agent-serve", describe: "start an extra-agent bridge server by id" }, () =>
      import("./cli/cmd/extra-agent-serve").then((m) => m.ExtraAgentServeCommand),
    ),
  )

cli = cli
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      void import("./cli/ui").then((mod) => {
        ui = mod.UI
        cli.showHelp(show)
        process.exit(1)
      })
      return
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    ui = (await import("./cli/ui")).UI
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const [{ NamedError }, { FormatError }] = await Promise.all([
    import("@opencode-ai/core/util/error"),
    import("./cli/error"),
  ])
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (isResolveMessage(e)) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  const Log = await lazyLog()
  const { UI } = await import("./cli/ui")
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  // Extension recovery holds mkdir lease gates; finish it first so no gate is left behind.
  const { ExtensionDrain } = await import("./extension/drain")
  await ExtensionDrain.drain()
  process.exit()
}
