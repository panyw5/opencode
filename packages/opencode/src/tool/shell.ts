import { Effect, Exit, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"
import { BackgroundShell } from "@/background/shell"
import { Env as PtyEnv } from "@/pty/env"
import { createHash } from "node:crypto"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])
const WRAPPERS = new Set(["builtin", "command", "env", "exec"])

type Part = {
  type: string
  text: string
  pattern?: boolean
  dynamic?: boolean
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
  fallback: boolean
}

type Chunk = {
  text: string
  size: number
}

export const log = Log.create({ service: "shell-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (
          !item ||
          item.type === "command_argument_sep" ||
          item.type === "redirection" ||
          item.type === "file_redirect" ||
          item.type === "heredoc_redirect" ||
          item.type === "herestring_redirect"
        ) {
          continue
        }
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      !child.isNamed ||
      child.type === "command_argument_sep" ||
      child.type === "redirection" ||
      child.type === "file_redirect" ||
      child.type === "heredoc_redirect" ||
      child.type === "herestring_redirect"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function envValue(key: string, env: NodeJS.ProcessEnv) {
  if (process.platform !== "win32") return env[key]
  const name = Object.keys(env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? env[name] : undefined
}

type Decoded = { value: string; dynamic: boolean; pattern?: boolean }

function hasBraceExpansion(text: string) {
  let quote: "single" | "double" | undefined
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote === "single") {
      if (char === "'") quote = undefined
      continue
    }
    if (char === "\\") {
      i++
      continue
    }
    if (char === "'" && quote !== "double") {
      quote = "single"
      continue
    }
    if (char === '"') {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (!quote && char === "{" && text[i - 1] !== "$") {
      const end = text.indexOf("}", i + 1)
      if (end >= 0 && /,|\.\./.test(text.slice(i + 1, end))) return true
    }
  }
  return false
}

function decodePosix(text: string, cwd: string, env: NodeJS.ProcessEnv): Decoded {
  let value = ""
  let dynamic = false
  let pattern = false
  let quote: "single" | "double" | undefined
  const tilde = text.startsWith("~") && (text.length === 1 || text[1] === "/")
  const namedTilde = text.startsWith("~") && !tilde
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote === "single") {
      if (char === "'") quote = undefined
      else value += char
      continue
    }
    if (char === "'" && quote !== "double") {
      quote = "single"
      continue
    }
    if (char === '"') {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (char === "\\") {
      const next = text[++i]
      if (next === undefined) {
        value += "\\"
        continue
      }
      if (quote === "double" && !["$", "`", '"', "\\", "\n"].includes(next)) value += "\\"
      if (next !== "\n") value += next
      continue
    }
    if (char === "`") {
      dynamic = true
      break
    }
    if (!quote && char === "(" && (text[i - 1] === "<" || text[i - 1] === ">")) {
      dynamic = true
      break
    }
    if (char !== "$") {
      if (!quote && /[?*[]/.test(char)) pattern = true
      value += char
      continue
    }
    const next = text[i + 1]
    if (next === "(") {
      dynamic = true
      break
    }
    let key = ""
    let end = i
    if (next === "{") {
      const close = text.indexOf("}", i + 2)
      if (close < 0) {
        dynamic = true
        break
      }
      const body = text.slice(i + 2, close)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
        dynamic = true
        break
      }
      key = body
      end = close
    } else {
      const match = text.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)
      if (!match) {
        dynamic = true
        break
      }
      key = match[0]
      end = i + key.length
    }
    const auto = key === "PWD" ? cwd : key === "HOME" ? envValue("HOME", env) || os.homedir() : undefined
    const expanded = auto ?? envValue(key, env)
    if (expanded === undefined) dynamic = true
    else {
      // Login shell startup files may change values, and unquoted values can split.
      dynamic = true
      if (!quote && /[?*[]/.test(expanded)) pattern = true
      value += expanded
    }
    i = end
  }
  if (tilde) {
    const expanded = envValue("HOME", env) || os.homedir()
    // The login shell can change HOME after preflight.
    dynamic = true
    if (/[?*[]/.test(expanded)) pattern = true
    value = path.join(expanded, value.slice(1))
  }
  if (namedTilde) dynamic = true
  return { value, dynamic, pattern }
}

export function decodePowerShellPath(text: string, cwd: string, shell: string, env: NodeJS.ProcessEnv): Decoded {
  let value = ""
  let dynamic = false
  let quote: "single" | "double" | undefined
  const expandTilde = text.startsWith("~") && (text.length === 1 || text[1] === "/" || text[1] === "\\")
  const lookup = (key: string) => {
    const normalized = key.toUpperCase()
    if (normalized === "HOME") return envValue("HOME", env) || envValue("USERPROFILE", env) || os.homedir()
    if (normalized === "PWD") return cwd
    if (normalized === "PSHOME") return path.dirname(shell)
    return envValue(key, env)
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote === "single") {
      if (char === "'" && text[i + 1] === "'") {
        value += "'"
        i++
      } else if (char === "'") quote = undefined
      else value += char
      continue
    }
    if (char === "`") {
      const next = text[i + 1]
      if (next === undefined) {
        value += char
        continue
      }
      const escapes: Record<string, string> = {
        "0": "\0",
        a: "\x07",
        b: "\b",
        e: "\x1b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\x0b",
      }
      value += escapes[next] ?? next
      i++
      continue
    }
    if (char === "'" && quote !== "double") {
      quote = "single"
      continue
    }
    if (char === '"') {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (char === "$") {
      let key: string | undefined
      let end = i
      const braced = text.slice(i).match(/^\$\{env:([^}]+)\}/i)
      const envVar = text.slice(i).match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)/i)
      const automatic = text.slice(i).match(/^\$(HOME|PWD|PSHOME)(?=$|[\\/])/i)
      if (braced) {
        key = braced[1]
        end = i + braced[0].length - 1
      } else if (envVar) {
        key = envVar[1]
        end = i + envVar[0].length - 1
      } else if (automatic) {
        key = automatic[1]
        end = i + automatic[0].length - 1
      } else {
        dynamic = true
        value += char
        continue
      }
      const expanded = lookup(key ?? "")
      if (expanded === undefined) dynamic = true
      else {
        // Same-command assignments can change variables after preflight.
        dynamic = true
        value += expanded
      }
      i = end
      continue
    }
    value += char
  }

  if (expandTilde) {
    dynamic = true
    value = path.join(lookup("HOME") || os.homedir(), value.slice(1))
  }
  return { value, dynamic, pattern: /[?*[]/.test(value) }
}

export function decodeCmd(text: string, env: NodeJS.ProcessEnv): Decoded {
  let value = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      quoted = !quoted
      continue
    }
    if (text[i] === "^" && i + 1 < text.length) {
      value += text[++i]
      continue
    }
    value += text[i]
  }
  let dynamic = quoted
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, key: string) => {
    const expanded = envValue(key, env)
    // CMD expansions can be changed by earlier SET commands in the line.
    dynamic = true
    return expanded ?? ""
  })
  if (value.includes("!")) dynamic = true
  return { value, dynamic, pattern: /[?*[]/.test(value) }
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function prefix(text: string, pattern = true) {
  if (!pattern) return text
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    const out: Part[] = []
    let positional = false
    for (const item of list.slice(1)) {
      if (!positional && item.text === "--") {
        positional = true
        continue
      }
      if (positional) {
        out.push(item)
        continue
      }
      if (item.text.startsWith("-")) continue
      if (cmd && item.text.startsWith("/")) continue
      if (list[0]?.text === "chmod" && item.text.startsWith("+")) continue
      out.push(item)
    }
    return out
  }

  const out: Part[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  log.info("shell permission scan ready", {
    sessionID: ctx.sessionID,
    callID: ctx.callID,
    externalDirectoryCount: scan.dirs.size,
    commandPatternCount: scan.patterns.size,
    fallback: scan.fallback,
  })
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      const pattern = path.join(dir, scan.fallback ? "**" : "*")
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(pattern)
      return pattern
    })
    log.info("shell external directory approval requested", {
      sessionID: ctx.sessionID,
      callID: ctx.callID,
      count: globs.length,
      fallback: scan.fallback,
    })
    const result = yield* Effect.exit(
      ctx.ask({
        permission: "external_directory",
        patterns: globs,
        always: globs,
        metadata: {},
      }),
    )
    log.info("shell external directory approval resolved", {
      sessionID: ctx.sessionID,
      callID: ctx.callID,
      count: globs.length,
      outcome: Exit.isSuccess(result) ? "approved" : "denied",
      fallback: scan.fallback,
    })
    if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
  }

  if (scan.patterns.size === 0) return
  log.info("shell command approval requested", {
    sessionID: ctx.sessionID,
    callID: ctx.callID,
    count: scan.patterns.size,
    fallback: scan.fallback,
  })
  const result = yield* Effect.exit(
    ctx.ask({
      permission: ShellID.ToolID,
      patterns: Array.from(scan.patterns),
      always: Array.from(scan.always),
      metadata: {},
    }),
  )
  log.info("shell command approval resolved", {
    sessionID: ctx.sessionID,
    callID: ctx.callID,
    count: scan.patterns.size,
    outcome: Exit.isSuccess(result) ? "approved" : "denied",
    fallback: scan.fallback,
  })
  if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const backgroundShell = yield* BackgroundShell.Service
    const defaultTimeout = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (
      arg: string,
      cwd: string,
      ps: boolean,
      shell: string,
      env: NodeJS.ProcessEnv,
      isDecoded = false,
      pattern?: boolean,
      isDynamic = false,
    ) {
      const decoded = isDecoded
        ? { value: arg, dynamic: isDynamic, pattern }
        : ps
          ? decodePowerShellPath(arg, cwd, shell, env)
          : Shell.name(shell) === "cmd"
            ? decodeCmd(arg, env)
            : decodePosix(arg, cwd, env)
      if (isDynamic) decoded.dynamic = true
      const file = prefix(decoded.value, decoded.pattern)
      if (!file && /[?*[]/.test(decoded.value)) return { path: cwd, dynamic: decoded.dynamic }
      if (!file) return { dynamic: decoded.dynamic }
      const next = ps ? provider(file) : file
      if (!next) return { dynamic: true as const }
      return { path: yield* resolvePath(next, cwd, shell), dynamic: decoded.dynamic }
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      env: NodeJS.ProcessEnv,
      commandText: string,
      instance: InstanceContext,
      sessionID: string,
      callID: string | undefined,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
        fallback: root.hasError,
      }
      const shellKind = ShellID.toKind(Shell.name(shell))
      const rootDir = path.parse(cwd).root
      let cwdUnknown = false

      const addPath = Effect.fnUntraced(function* (
        arg: string,
        base: string,
        isDecoded = false,
        pattern?: boolean,
        isDynamic = false,
      ) {
        const resolved = yield* argPath(arg, base, ps, shell, env, isDecoded, pattern, isDynamic)
        log.info("shell path checked", {
          sessionID,
          callID,
          fingerprint: createHash("sha256").update(arg).digest("hex").slice(0, 12),
          startsQuoted: /^[\"']/.test(arg),
          startsTilde: arg.startsWith("~"),
          dynamic: resolved.dynamic,
          resolved: Boolean(resolved.path),
          external: Boolean(resolved.path && !containsPath(resolved.path, instance)),
        })
        if (resolved.path && !containsPath(resolved.path, instance)) {
          const dir = (yield* fs.isDir(resolved.path)) ? resolved.path : path.dirname(resolved.path)
          scan.dirs.add(dir)
        }
        if (resolved.dynamic) scan.fallback = true
      })

      if (root.hasError) {
        log.warn("shell permission scan used fallback", {
          reason: "incomplete syntax tree",
          sessionID,
          callID,
          fingerprint: createHash("sha256").update(commandText).digest("hex").slice(0, 12),
          length: commandText.length,
          lines: commandText.split("\n").length,
        })
        scan.dirs.add(rootDir)
        scan.patterns.add(commandText)
        scan.always.add(commandText)
        return scan
      }

      for (const node of commands(root)) {
        const raw = parts(node)
        const hasAssignments = raw.some((item) => item.type === "variable_assignment")
        const decoded = raw.map((item) =>
          ps
            ? decodePowerShellPath(item.text, cwd, shell, env)
            : shellKind === "cmd"
              ? decodeCmd(item.text, env)
              : decodePosix(item.text, cwd, env),
        )
        const command = raw
          .map((item, index) => ({
            ...item,
            text: decoded[index]?.value ?? item.text,
            pattern: decoded[index]?.pattern,
            dynamic:
              decoded[index]?.dynamic ||
              (shellKind !== "cmd" && !ps && hasBraceExpansion(item.text)) ||
              item.type === "process_substitution",
          }))
          .filter((item) => item.type !== "variable_assignment")
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]
        const wrapped = command[1]?.text.toLowerCase()
        const wrapperFallback =
          !ps &&
          WRAPPERS.has(cmd ?? "") &&
          (!wrapped || wrapped.startsWith("-") || FILES.has(wrapped) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(wrapped))
        if (command[0]?.dynamic || wrapperFallback || (hasAssignments && Boolean(cmd && FILES.has(cmd)))) {
          scan.fallback = true
        }

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            if (cwdUnknown && !path.isAbsolute(arg.text)) {
              scan.fallback = true
              continue
            }
            yield* addPath(arg.text, cwd, true, arg.pattern, arg.dynamic)
          }
        }

        if (cmd && CWD.has(cmd)) cwdUnknown = true

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      const pending: Node[] = [root]
      while (pending.length) {
        const node = pending.pop()!
        if (ps && /redirect|redirection/i.test(node.type) && node.type !== "file_redirect") {
          scan.fallback = true
        }
        if (node.type === "file_redirect") {
          const statement = node.parent?.type === "redirected_statement" ? node.parent.text.trim() : node.text.trim()
          scan.patterns.add(statement)
          scan.always.add(statement)
          let destination: Node | undefined
          let descriptorDuplication = false
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i)
            if (child?.text === ">&" || child?.text === "<&") descriptorDuplication = true
            if (node.fieldNameForChild(i) === "destination") {
              destination = child ?? undefined
              break
            }
          }
          if (destination && !(destination.type === "number" && descriptorDuplication)) {
            if (cwdUnknown && !path.isAbsolute(destination.text)) scan.fallback = true
            else
              yield* addPath(
                destination.text,
                cwd,
                false,
                undefined,
                hasBraceExpansion(destination.text) || destination.type === "process_substitution",
              )
          }
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (child) pending.push(child)
        }
      }

      if (scan.fallback) {
        scan.dirs.add(rootDir)
        scan.patterns.add(commandText)
        scan.always.add(commandText)
      }
      log.info("shell permission scan completed", {
        sessionID,
        callID,
        commandCount: commands(root).length,
        externalDirectoryCount: scan.dirs.size,
        commandPatternCount: scan.patterns.size,
        fallback: scan.fallback,
      })

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      log.info("shell environment preflight resolved", {
        sessionID: ctx.sessionID,
        callID: ctx.callID,
        pluginEntryCount: Object.keys(extra.env).length,
      })
      return PtyEnv.prepare({ plugin: extra.env })
    })

    function backgroundOutput(info: BackgroundShell.Info) {
      return [
        `background_shell_id: ${info.id}`,
        `pty_id: ${info.ptyID}`,
        "state: running",
        "",
        "<background_shell>",
        "Background shell started. Continue other work; OpenCode will notify you when it completes or fails.",
        "</background_shell>",
      ].join("\n")
    }

    function sentToBackgroundOutput(info: BackgroundShell.Info) {
      return [
        `background_shell_id: ${info.id}`,
        `pty_id: ${info.ptyID}`,
        "state: running",
        "",
        "<background_shell>",
        "Shell command is now running in the background. Continue other work; OpenCode will notify you when it completes or fails.",
        "</background_shell>",
      ].join("\n")
    }

    function metadata(
      info: BackgroundShell.Info,
      description: string,
      output: string,
      extra?: { truncated?: boolean; outputPath?: string },
    ) {
      return {
        output,
        exit: info.exitCode ?? null,
        description,
        truncated: extra?.truncated ?? false,
        ...(extra?.truncated && extra.outputPath ? { outputPath: extra.outputPath } : {}),
        background: info.background,
        jobId: info.id,
        ptyId: info.ptyID,
        status: info.status,
      }
    }

    function cleanEnv(env: NodeJS.ProcessEnv) {
      return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
    }

    const finalizeOutput = Effect.fn("ShellTool.finalizeOutput")(function* (raw: string, note?: string) {
      const limits = yield* trunc.limits()
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      let file = ""
      if (end.cut) file = yield* trunc.write(raw)
      let output = end.text
      if (!output) output = "(no output)"
      if (end.cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }
      if (note) {
        output += "\n\n<shell_metadata>\n" + note + "\n</shell_metadata>"
      }
      return { output, cut: end.cut, file }
    })

    const runSupervised = Effect.fn("ShellTool.runSupervised")(function* (
      input: {
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
        background: boolean
      },
      ctx: Tool.Context,
    ) {
      const fingerprint = createHash("sha256").update(input.command).digest("hex").slice(0, 12)
      log.info("supervised shell preparation started", {
        sessionID: ctx.sessionID,
        callID: ctx.callID,
        commandFingerprint: fingerprint,
        commandLength: input.command.length,
        commandLines: input.command.split("\n").length,
        envEntryCount: Object.keys(input.env).length,
      })
      let latest = yield* backgroundShell.create(
        {
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          command: input.command,
          cwd: input.cwd,
          description: input.description,
          env: cleanEnv(input.env),
          background: input.background,
        },
        { shellEnvResolved: true },
      )
      log.info("supervised shell process prepared", {
        sessionID: latest.sessionID,
        messageID: latest.messageID,
        callID: latest.callID,
        jobID: latest.id,
        ptyID: latest.ptyID,
        commandFingerprint: fingerprint,
      })

      const update = Effect.fn("ShellTool.updateSupervisedMetadata")(function* (info: BackgroundShell.Info) {
        latest = info
        yield* ctx.metadata({
          title: input.description,
          metadata: metadata(info, input.description, info.outputTail ?? ""),
        })
      })

      yield* update(latest)

      if (input.background) {
        log.info("supervised shell background started", {
          sessionID: latest.sessionID,
          callID: latest.callID,
          jobID: latest.id,
          ptyID: latest.ptyID,
        })
        const output = backgroundOutput(latest)
        return {
          title: input.description,
          metadata: metadata(latest, input.description, output),
          output,
        }
      }

      const poll: Effect.Effect<void> = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("300 millis")
          const info = yield* backgroundShell.get(latest.id)
          if (info) yield* update(info)
        }
      })

      const abort = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) return resume(Effect.void)
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(poll)
          return yield* Effect.raceAll([
            backgroundShell.wait(latest.id).pipe(Effect.map((value) => ({ kind: "wait" as const, value }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const }))),
            Effect.sleep(`${input.timeout + 100} millis`).pipe(Effect.map(() => ({ kind: "timeout" as const }))),
          ])
        }),
      )

      if (result.kind === "abort" || result.kind === "timeout") {
        const note =
          result.kind === "abort"
            ? "User aborted the command"
            : `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer, run it with background=true or send it to background before the timeout.`
        // Capture the full PTY buffer while the process is still alive, then stop it.
        const full = yield* backgroundShell.output(latest.id)
        const stopped = yield* backgroundShell.stop(latest.id)
        if (stopped) latest = stopped
        log.info("supervised shell settled", {
          sessionID: latest.sessionID,
          callID: latest.callID,
          jobID: latest.id,
          ptyID: latest.ptyID,
          status: latest.status,
          reason: result.kind,
          commandFingerprint: createHash("sha256").update(input.command).digest("hex").slice(0, 12),
        })
        const fin = yield* finalizeOutput(full ?? latest.outputTail ?? "", note)
        return {
          title: input.description,
          metadata: metadata(latest, input.description, fin.output, {
            truncated: fin.cut,
            outputPath: fin.file,
          }),
          output: fin.output,
        }
      }

      if (result.value.backgrounded) {
        latest = result.value.info ?? latest
        log.info("supervised shell moved to background", {
          sessionID: latest.sessionID,
          callID: latest.callID,
          jobID: latest.id,
          ptyID: latest.ptyID,
        })
        const output = sentToBackgroundOutput(latest)
        return {
          title: input.description,
          metadata: metadata(latest, input.description, output),
          output,
        }
      }

      latest = result.value.info ?? latest
      log.info("supervised shell settled", {
        sessionID: latest.sessionID,
        callID: latest.callID,
        jobID: latest.id,
        ptyID: latest.ptyID,
        status: latest.status,
        exitCode: latest.exitCode,
        commandFingerprint: createHash("sha256").update(input.command).digest("hex").slice(0, 12),
      })
      const fin = yield* finalizeOutput(result.value.output ?? latest.outputTail ?? "")
      return {
        title: input.description,
        metadata: metadata(latest, input.description, fin.output, {
          truncated: fin.cut,
          outputPath: fin.file,
        }),
        output: fin.output,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          log.info("shell process spawn requested", {
            shell: Shell.name(input.shell),
            fingerprint: createHash("sha256").update(input.command).digest("hex").slice(0, 12),
            length: input.command.length,
            lines: input.command.split("\n").length,
          })
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits)
        log.info("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeout
              const ps = Shell.ps(shell)
              log.info("shell command received", {
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                callID: ctx.callID,
                shell: name,
                commandFingerprint: createHash("sha256").update(params.command).digest("hex").slice(0, 12),
                commandLength: params.command.length,
                commandLines: params.command.split("\n").length,
              })
              const env = yield* shellEnv(ctx, cwd)
              log.info("shell command validation started", {
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                shell: name,
                fingerprint: createHash("sha256").update(params.command).digest("hex").slice(0, 12),
                length: params.command.length,
                lines: params.command.split("\n").length,
              })
              yield* Effect.scoped(
                Effect.gen(function* () {
                  log.info("shell syntax parse started", { sessionID: ctx.sessionID, callID: ctx.callID, shell: name })
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  log.info("shell syntax parse completed", {
                    sessionID: ctx.sessionID,
                    callID: ctx.callID,
                    shell: name,
                    incomplete: tree.rootNode.hasError,
                  })
                  const scan = yield* collect(
                    tree.rootNode,
                    cwd,
                    ps,
                    shell,
                    env,
                    params.command,
                    instanceCtx,
                    ctx.sessionID,
                    ctx.callID,
                  )
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan)
                }),
              )
              log.info("shell command validation passed", {
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                commandFingerprint: createHash("sha256").update(params.command).digest("hex").slice(0, 12),
              })

              return yield* runSupervised(
                {
                  command: params.command,
                  cwd,
                  env,
                  timeout,
                  description: params.description,
                  background: params.background === true,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
