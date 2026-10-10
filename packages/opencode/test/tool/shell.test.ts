import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "../../src/shell/shell"
import { ShellTool } from "../../src/tool/shell"
import { ShellPrompt } from "../../src/tool/shell/prompt"
import { decodeCmd, decodePowerShellPath } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { BackgroundShell } from "@/background/shell"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  BackgroundShell.defaultLayer,
)
const it = testEffect(shellLayer)

let shellEnvHookCalls = 0
const statefulShellEnvPlugin = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
    if (name !== "shell.env") return Effect.succeed(output)
    shellEnvHookCalls++
    const prior = output as { env: Record<string, string> }
    return Effect.succeed({
      ...prior,
      env: {
        ...prior.env,
        OPENCODE_SHELL_ENV_PROBE: `preflight-${shellEnvHookCalls}`,
        TERM: "plugin-term",
        OPENCODE_TERMINAL: "plugin-terminal",
      },
    })
  },
  list: () => Effect.succeed([]),
  listHookControls: () => Effect.succeed([]),
  setHookControl: () => Effect.succeed([]),
  init: () => Effect.void,
})
const itWithStatefulShellEnv = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    statefulShellEnvPlugin,
    Truncate.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
    RuntimeFlags.defaultLayer,
    BackgroundShell.defaultLayer,
  ),
)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const eachPosix = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells.filter((item) => Shell.posix(item.shell))) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  test("describes one-call shell execution and accepts literal multiline commands", () => {
    const prompt = ShellPrompt.render("bash", "darwin", { maxLines: 100, maxBytes: 10_000 })
    expect(prompt.description).toContain("fresh bash process for each call")
    expect(prompt.description).toContain("literal newlines, multiline commands, and heredocs")
    expect(prompt.description).not.toContain("DO NOT use newlines to separate commands")
    const command = prompt.parameters.ast.propertySignatures.find((item) => item.name === "command")
    expect(command?.type.annotations?.description).toContain("Raw command text")
    expect(command?.type.annotations?.description).toContain("do not JSON-escape shell syntax")
  })

  test("keeps PowerShell single-quoted and escaped environment syntax literal", () => {
    const env = { HOME: "C:/Users/with spaces", USERPROFILE: "C:/Users/with spaces" }
    expect(decodePowerShellPath("'$env:HOME/private'", "C:/work", "C:/pwsh/pwsh.exe", env)).toMatchObject({
      value: "$env:HOME/private",
      dynamic: false,
    })
    expect(decodePowerShellPath("'a''$env:HOME'", "C:/work", "C:/pwsh/pwsh.exe", env)).toMatchObject({
      value: "a'$env:HOME",
      dynamic: false,
    })
    expect(decodePowerShellPath('"$env:HOME/private"', "C:/work", "C:/pwsh/pwsh.exe", env).value).toBe(
      "C:/Users/with spaces/private",
    )
    expect(decodePowerShellPath('"`$env:HOME/private"', "C:/work", "C:/pwsh/pwsh.exe", env).value).toBe(
      "$env:HOME/private",
    )
    expect(decodePowerShellPath("$env:HOME/private", "C:/work", "C:/pwsh/pwsh.exe", env).dynamic).toBe(true)
    expect(decodePowerShellPath("~/private", "C:/work", "C:/pwsh/pwsh.exe", env).dynamic).toBe(true)
    expect(decodeCmd("%TEMP%\\private", { TEMP: "C:/temp" }).dynamic).toBe(true)
  })

  for (const item of shells.filter((item) => Shell.posix(item.shell))) {
    it.live(`passes multiline and heredoc text to the selected shell [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: "cat <<'EOF'\nline $HOME\nEOF\nprintf '\\nsecond\\n'",
              description: "Print a multiline heredoc",
            })
            expect(result.metadata.exit).toBe(0)
            expect(result.output.replaceAll("\r\n", "\n")).toContain("line $HOME\n\nsecond\n")
          }),
        ),
      ),
    )

    itWithStatefulShellEnv.live(`reuses the inspected shell.env values for the supervised PTY [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          shellEnvHookCalls = 0
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const result = yield* run({
                command: 'printf "%s|%s|%s" "$OPENCODE_SHELL_ENV_PROBE" "$TERM" "$OPENCODE_TERMINAL"',
                description: "Print resolved shell environment",
              })
              expect(result.metadata.exit).toBe(0)
              expect(result.output).toContain("preflight-1|xterm-256color|1")
              expect(shellEnvHookCalls).toBe(1)
            }),
          )
        }),
      ),
    )

    it.live(`direct background shell retains immediate PTY output [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const background = yield* BackgroundShell.Service
              const info = yield* background.create({
                sessionID: ctx.sessionID,
                cwd: tmp,
                command: "printf 'fast-output'; sleep 0.1",
                description: "Print immediate PTY output",
              })
              const result = yield* background.wait(info.id)
              expect(result.output).toContain("fast-output")
            }),
          )
        }),
      ),
    )
  }

  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
          description: "Echo test message",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
              description: "Echo fallback text",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
              description: "Echo twice",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
                description: "Check PowerShell conditional",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                    description: "Remove a temp directory",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
              description: "Read wildcard path",
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq, JSON.stringify(requests)).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  eachPosix("recognizes quoted command names and escaped paths", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `"cat" \\../outside.txt`,
              description: "Read escaped external path",
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq, JSON.stringify(requests)).toBeDefined()
          expect(extDirReq!.patterns).toContain(path.join(path.dirname(tmp), "*"))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
        }),
      )
    }),
  )

  eachPosix("does not expand quoted tilde paths", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cat '~/file'",
              description: "Read literal tilde path",
            },
            capture(requests),
          )
          expect(
            requests.filter((r) => r.permission === "external_directory"),
            JSON.stringify(requests),
          ).toHaveLength(0)
        }),
      )
    }),
  )

  eachPosix("distinguishes quoted literal wildcard paths from shell globs", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const globRequests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              { command: "cat ../wild*/outside.txt", description: "Read wildcard path" },
              capture(globRequests, err),
            ),
          ).toMatchObject({ message: err.message })
          expect(globRequests[0]?.patterns).toContain(path.join(path.dirname(tmp), "*"))

          const literalRequests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              { command: "cat '../wild*/outside.txt'", description: "Read literal wildcard path" },
              capture(literalRequests, err),
            ),
          ).toMatchObject({ message: err.message })
          expect(literalRequests[0]?.patterns).toContain(path.join(path.dirname(tmp), "wild*", "*"))
        }),
      )
    }),
  )

  eachPosix("resolves simple environment variables and paths after --", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const envRequests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: 'cat "$HOME/.ssh/config"',
                description: "Read home config",
              },
              capture(envRequests, err),
            ),
          ).toMatchObject({ message: err.message })
          const homeReq = envRequests.find((r) => r.permission === "external_directory")
          expect(homeReq).toBeDefined()
          expect(homeReq!.patterns).toContain(path.join(os.homedir(), ".ssh", "**"))
          expect(homeReq!.patterns).toContain(path.join(path.parse(tmp).root, "**"))

          const unknownRequests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: 'cat "$OPENCODE_SHELL_UNKNOWN_PATH_7B31/file"',
                description: "Read unresolved environment path",
              },
              capture(unknownRequests, err),
            ),
          ).toMatchObject({ message: err.message })
          expect(unknownRequests[0]?.permission).toBe("external_directory")
          expect(unknownRequests[0]?.patterns).toContain(path.join(path.parse(tmp).root, "**"))

          const optionRequests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cat -- -/../../outside.txt",
                description: "Read path after end-of-options marker",
              },
              capture(optionRequests, err),
            ),
          ).toMatchObject({ message: err.message })
          expect(optionRequests.some((r) => r.permission === "external_directory")).toBe(true)
        }),
      )
    }),
  )

  eachPosix("checks redirection-only paths before allowing filesystem mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const file = `opencode-shell-redirection-${Math.random().toString(36).slice(2)}.txt`
          const target = path.resolve(tmp, "..", file)
          const err = new Error("deny external directory")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const denyCommand = {
            ...ctx,
            ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                requests.push(req)
                if (req.permission === "bash") throw err
              }),
          }
          expect(
            yield* fail(
              {
                command: `> ../${file}`,
                description: "Write external redirection target",
              },
              denyCommand,
            ),
          ).toMatchObject({ message: err.message })
          expect(requests[0]?.permission).toBe("external_directory")
          expect(requests[0]?.patterns).toContain(path.join(path.dirname(tmp), "*"))
          expect(requests[1]?.permission).toBe("bash")
          expect(requests[1]?.patterns).toContain(`> ../${file}`)
          expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
        }),
      )
    }),
  )

  eachPosix("checks nested, input, append, and descriptor redirection paths", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const commands = [
            "echo $(cat ../outside.txt)",
            "cat <(cat ../outside.txt)",
            "cat {../outside.txt,inside.txt}",
            "> {../outside.txt,inside.txt}",
            "cat < ../outside.txt",
            "printf x >> ../outside.txt",
            "echo x 2> ../outside.txt",
            "echo x >& ../outside.txt",
          ]
          for (const command of commands) {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            const err = new Error("stop after external directory approval")
            expect(
              yield* fail({ command, description: "Check redirected external path" }, capture(requests, err)),
            ).toMatchObject({ message: err.message })
            expect(requests[0]?.permission, command).toBe("external_directory")
          }
        }),
      )
    }),
  )

  eachPosix("treats numeric redirection destinations as filenames", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after command approval")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail({ command: "> 123", description: "Write numeric filename" }, capture(requests, err)),
          ).toMatchObject({ message: err.message })
          expect(requests[0]?.permission).toBe("bash")
          expect(requests[0]?.patterns).toContain("> 123")
        }),
      )
    }),
  )

  eachPosix("falls back for unquoted environment values that may split into path arguments", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const key = "OPENCODE_SHELL_SPLIT_PATH_7B31"
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.env[key]
          process.env[key] = "./inside ../outside"
          return previous
        }),
        () =>
          runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after external directory approval")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  { command: `cat $${key}`, description: "Read split environment paths" },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              expect(requests[0]?.patterns).toContain(path.join(path.parse(tmp).root, "**"))
            }),
          ),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[key]
            else process.env[key] = previous
          }),
      )
    }),
  )

  eachPosix("uses broad approval for inline environment assignments and command wrappers", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          for (const command of ['HOME=/outside cat "$HOME/file"', "command cat ../outside.txt"]) {
            const err = new Error("stop after external directory approval")
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            expect(
              yield* fail({ command, description: "Check wrapped path command" }, capture(requests, err)),
            ).toMatchObject({ message: err.message })
            expect(requests[0]?.permission).toBe("external_directory")
            expect(requests[0]?.patterns).toContain(path.join(path.parse(tmp).root, "**"))
          }
        }),
      )
    }),
  )

  eachPosix("keeps quoted environment syntax literal and avoids path fallback for data arguments", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "printf '%s' '$OPENCODE_SHELL_LITERAL_PATH_7B31'; cat '$OPENCODE_SHELL_LITERAL_PATH_7B31/file'",
              description: "Use literal shell data",
            },
            capture(requests),
          )
          expect(requests.some((r) => r.permission === "external_directory")).toBe(false)
        }),
      )
    }),
  )

  eachPosix("uses conservative approvals for incomplete syntax and cwd-changing commands", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const malformed: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        yield* run({ command: "cat (", description: "Incomplete shell syntax" }, capture(malformed))
        expect(malformed[0]?.permission).toBe("external_directory")
        expect(malformed[0]?.patterns).toContain(path.join(path.parse(projectRoot).root, "**"))
        expect(malformed.some((r) => r.permission === "bash" && r.patterns.includes("cat ("))).toBe(true)

        const cwdChange: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        expect(
          yield* fail(
            { command: "cd /tmp && cat relative.txt", description: "Change directory then read" },
            capture(cwdChange, err),
          ),
        ).toMatchObject({ message: err.message })
        expect(cwdChange[0]?.permission).toBe("external_directory")
        expect(cwdChange[0]?.patterns).toContain(path.join(path.parse(projectRoot).root, "**"))
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                    description: "Read nested bash file",
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                    description: "Copy Windows ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                  description: "Read nested PowerShell file",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                      description: "Read drive-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                    description: "Read home config",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                      description: "Read pwd-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                    description: "Read pshome file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "OPENCODE_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                        description: "Read Windows ini with missing env",
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                  description: "Read Windows ini from env",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                    description: "Read Windows ini from FileSystem provider",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                    description: "Read Windows ini from braced env",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                  description: "Change location",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                  description: "Write repeated text",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
                description: "Read Windows ini with cmd",
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
                description: "Change to parent directory",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
                description: "Echo from temp dir",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                    description: "Echo from Git Bash tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/opencode-does-not-exist",
                    description: "Read Git Bash tmp file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
                description: "Read external file",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
              description: "Remove nested dir",
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
              description: "Git log",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
              description: "Stay in current directory",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              { command: "echo test > output.txt", description: "Redirect test output" },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "ls -la", description: "List" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe("ls *")
        }),
      )
    }),
  )
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: `echo before && sleep 30`,
              description: "Long running command",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      withShell(
        { label: "sh", shell: "/bin/sh" },
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const result = yield* run({
              command: `echo started && sleep 60`,
              description: "Timeout test",
              timeout: 500,
            })
            expect(result.output).toContain("started")
            expect(result.output).toContain("shell tool terminated command after exceeding timeout")
            expect(result.output).toContain("run it with background=true")
          }),
        ),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo started && sleep 60`,
            description: "Default timeout test",
          })
          expect(result.output).toContain("started")
          expect(result.output).toContain("exceeding timeout 500 ms")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
            description: "Stderr test",
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
          description: "Non-zero exit",
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            // Outlive several 300ms metadata polls so progressive updates accumulate.
            command: `echo first && sleep 0.8 && echo second && sleep 0.8`,
            description: "Streaming test",
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
          description: "Generate bytes exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
          description: "Generate one line",
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines for file check",
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* AppFileSystem.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})
