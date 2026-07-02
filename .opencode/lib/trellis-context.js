/* global process */
import { execFileSync } from "child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { extname, isAbsolute, join, relative, resolve } from "path"

const DEBUG = process.env.TRELLIS_PLUGIN_DEBUG === "1"
const TEXT_FILE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsonc",
  ".jsonl",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
])

export function debugLog(scope, ...args) {
  if (DEBUG) {
    console.error(`[trellis:${scope}]`, ...args)
  }
}

export const contextCollector = {
  processed: new Set(),

  isProcessed(sessionID) {
    return this.processed.has(sessionID)
  },

  markProcessed(sessionID) {
    if (sessionID) this.processed.add(sessionID)
  },

  clear(sessionID) {
    if (sessionID) this.processed.delete(sessionID)
  },
}

export class TrellisContext {
  constructor(directory) {
    this.directory = resolve(directory)
  }

  resolvePath(file) {
    if (!file) return this.directory
    return isAbsolute(file) ? file : join(this.directory, file)
  }

  isInsideProject(file) {
    const rel = relative(this.directory, resolve(file))
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  }

  readFile(file) {
    const target = this.resolvePath(file)
    if (!this.isInsideProject(target) || !existsSync(target)) return ""
    try {
      return readFileSync(target, "utf-8")
    } catch (error) {
      debugLog("context", "readFile failed:", target, error.message)
      return ""
    }
  }

  readProjectFile(file) {
    return this.readFile(file)
  }

  runScript(script, args = []) {
    const target = this.resolvePath(script)
    if (!this.isInsideProject(target) || !existsSync(target)) return ""

    const command = extname(target) === ".py" ? "python3" : target
    const commandArgs = command === target ? args : [target, ...args]
    try {
      return execFileSync(command, commandArgs, {
        cwd: this.directory,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      })
    } catch (error) {
      debugLog("context", "runScript failed:", target, error.message)
      return ""
    }
  }

  getCurrentTask() {
    const value = this.readProjectFile(".trellis/.current-task").trim()
    return value || ""
  }

  resolveTaskDir(taskRef) {
    if (!taskRef) return ""

    const candidates = [
      this.resolvePath(taskRef),
      this.resolvePath(join(".trellis", "tasks", taskRef)),
    ]

    for (const candidate of candidates) {
      if (this.isInsideProject(candidate) && existsSync(candidate)) return candidate
    }

    return ""
  }

  readJsonlWithFiles(jsonlPath) {
    const content = this.readFile(jsonlPath)
    if (!content) return []

    const entries = []
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const entry = JSON.parse(trimmed)
        const file = entry.file || entry.path
        if (!file) continue

        const fullPath = this.resolvePath(file)
        if (!this.isInsideProject(fullPath) || !existsSync(fullPath)) {
          entries.push({ ...entry, path: file, content: `[missing: ${file}]` })
          continue
        }

        if ((entry.type || "file") === "directory") {
          entries.push({ ...entry, path: file, content: this.readDirectoryContext(fullPath, file) })
          continue
        }

        entries.push({ ...entry, path: file, content: this.readFile(file) })
      } catch (error) {
        debugLog("context", "Invalid jsonl entry:", error.message)
      }
    }
    return entries
  }

  readDirectoryContext(directory, label) {
    const parts = []
    const visit = (current) => {
      let children = []
      try {
        children = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }

      for (const child of children) {
        if (child.name.startsWith(".") || child.name === "node_modules") continue
        const childPath = join(current, child.name)
        if (!this.isInsideProject(childPath)) continue

        if (child.isDirectory()) {
          visit(childPath)
          continue
        }

        if (!TEXT_FILE_EXTENSIONS.has(extname(child.name))) continue
        try {
          const st = statSync(childPath)
          if (st.size > 512 * 1024) continue
          const rel = relative(this.directory, childPath)
          parts.push(`=== ${rel} ===\n${readFileSync(childPath, "utf-8")}`)
        } catch {
          // Skip unreadable files.
        }
      }
    }

    visit(directory)
    return parts.join("\n\n") || `[empty directory: ${label}]`
  }

  buildContextFromEntries(entries) {
    return entries
      .map((entry) => {
        const reason = entry.reason ? ` (${entry.reason})` : ""
        return `=== ${entry.path}${reason} ===\n${entry.content || ""}`
      })
      .join("\n\n")
  }
}
