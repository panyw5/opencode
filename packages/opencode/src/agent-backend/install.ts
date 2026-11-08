import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { which } from "@/util/which"
import { adapterCatalog, type AdapterRecipe, type ManagedAdvisor } from "./catalog"

const log = Log.create({ service: "agent-backend.install" })
export class AgentInstallError extends Error {
  constructor(
    readonly kind: "invalid" | "busy" | "dependency" | "integrity",
    message: string,
  ) {
    super(message)
  }
}
type Receipt = { advisor: string; version: string; integrity: string; installedAt: number }
type Prepared = {
  token: string
  expiresAt: number
  advisor: ManagedAdvisor
  version: string
  action: "install" | "remove"
}
export type PackageRunner = (command: string[], cwd: string, signal: AbortSignal) => Promise<string>

export const runPackageCommand: PackageRunner = (command, cwd, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Operation cancelled"))
      return
    }
    log.info(`command start executable=${path.basename(command[0])} cwd=${cwd} argc=${command.length - 1}`)
    const child = spawn(command[0], command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" },
    })
    let output = ""
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16000)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, kind)
        else child.kill(kind)
      } catch {}
    }
    let escalation: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      kill("SIGTERM")
      escalation ??= setTimeout(() => kill("SIGKILL"), 1000)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    child.once("error", reject)
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort)
      clearTimeout(escalation)
      log.info(`command finished pid=${child.pid} exit=${code} cancelled=${signal.aborted}`)
      if (signal.aborted) reject(new Error("Operation cancelled or timed out"))
      else if (code !== 0) reject(new Error(`Package manager failed (exit ${code}). ${output.slice(-3000)}`))
      else resolve(output.trim())
    })
  })

/** App-owned installation store. No registry commands or shell fragments are executed. */
export class AgentInstallManager {
  private readonly prepared = new Map<string, Prepared>()
  constructor(
    readonly root = path.join(Global.Path.data, "agent-backends"),
    private readonly catalog: AdapterRecipe[] = adapterCatalog,
    private readonly runner: PackageRunner = runPackageCommand,
    private readonly binaries = { node: which("node"), npm: which(process.platform === "win32" ? "npm.cmd" : "npm") },
  ) {}

  private release(advisor: string, version: string) {
    const recipe = this.catalog.find((item) => item.advisor === advisor)
    const release = recipe?.releases.find((item) => item.version === version)
    if (!recipe || !release || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
      throw new AgentInstallError("invalid", "This adapter/version is not in the reviewed installation catalog")
    return { recipe, release }
  }

  private directory(advisor: string, version: string) {
    this.release(advisor, version)
    return path.join(this.root, "versions", advisor, version)
  }
  private async runtime() {
    const node = this.binaries.node
    const npm = this.binaries.npm
    if (!node || !npm)
      throw new AgentInstallError("dependency", "Install Node.js >=22 and npm on the target backend machine first")
    const version = await this.runner([node, "--version"], this.root, AbortSignal.timeout(10000))
    if (Number(version.match(/^v(\d+)/)?.[1] ?? 0) < 22)
      throw new AgentInstallError("dependency", "Node.js >=22 is required on the backend machine")
    const cli = await fs.realpath(npm)
    const npmEntry = /\.cmd$/i.test(cli) ? path.join(path.dirname(cli), "node_modules/npm/bin/npm-cli.js") : cli
    return { node, npm: /\.(?:m?js)$/i.test(npmEntry) ? [node, npmEntry] : [npmEntry] }
  }

  private async lock<T>(advisor: string, task: () => Promise<T>): Promise<T> {
    const directory = path.join(this.root, "locks", advisor)
    await fs.mkdir(path.dirname(directory), { recursive: true })
    try {
      await fs.mkdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const owner = await fs
        .readFile(path.join(directory, "owner.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined)
      let alive = true
      if (owner?.pid) {
        try {
          process.kill(owner.pid, 0)
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== "ESRCH"
        }
      }
      if (alive) throw new AgentInstallError("busy", "Another adapter operation is running; wait for it to finish")
      await fs.rm(directory, { recursive: true, force: true })
      return this.lock(advisor, task)
    }
    try {
      await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid }))
      return await task()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }

  async resolve(advisor: string, version: string, allowMissingRuntime = false): Promise<string[]> {
    const { recipe, release } = this.release(advisor, version)
    const directory = this.directory(advisor, version)
    const receipt: Receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"))
    if (receipt.advisor !== advisor || receipt.version !== version || receipt.integrity !== release.integrity)
      throw new AgentInstallError("integrity", "Managed adapter receipt does not match the reviewed release")
    const module = path.join(directory, "node_modules", recipe.package)
    const packageJSON = JSON.parse(await fs.readFile(path.join(module, "package.json"), "utf8"))
    if (packageJSON.name !== recipe.package || packageJSON.version !== version)
      throw new AgentInstallError("integrity", "Managed adapter package identity does not match its receipt")
    const entry = await fs.realpath(path.join(module, recipe.entry))
    const canonical = await fs.realpath(directory)
    if (!entry.startsWith(canonical + path.sep))
      throw new AgentInstallError("integrity", "Adapter executable escapes the managed installation")
    if (!this.binaries.node && !allowMissingRuntime)
      throw new AgentInstallError("dependency", "Node.js is not installed on this backend")
    return [this.binaries.node ?? "node", entry]
  }

  async status() {
    await fs.mkdir(this.root, { recursive: true })
    const adapters = []
    for (const recipe of this.catalog) {
      const installed = []
      for (const release of recipe.releases) {
        try {
          const command = await this.resolve(recipe.advisor, release.version, true)
          const receipt: Receipt = JSON.parse(
            await fs.readFile(path.join(this.directory(recipe.advisor, release.version), "receipt.json"), "utf8"),
          )
          installed.push({ version: release.version, installedAt: receipt.installedAt, command })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            log.warn(`inspection failed advisor=${recipe.advisor} version=${release.version} error=${String(error)}`)
        }
      }
      adapters.push({
        advisor: recipe.advisor,
        package: recipe.package,
        source: recipe.source,
        loginHelp: recipe.loginHelp,
        requires: recipe.requires,
        recommended: recipe.releases[0].version,
        releases: recipe.releases.map((item) => item.version),
        installed,
      })
    }
    return {
      target: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      directory: this.root,
      node: this.binaries.node ?? null,
      npm: this.binaries.npm ?? null,
      adapters,
    }
  }

  prepare(input: { advisor: ManagedAdvisor; version: string; action: "install" | "remove" }) {
    const { recipe, release } = this.release(input.advisor, input.version)
    for (const [token, value] of this.prepared) if (value.expiresAt < Date.now()) this.prepared.delete(token)
    if (this.prepared.size >= 100) throw new AgentInstallError("busy", "Too many pending confirmations")
    const value = { ...input, token: randomUUID(), expiresAt: Date.now() + 5 * 60 * 1000 }
    this.prepared.set(value.token, value)
    log.info(
      `prepared advisor=${input.advisor} action=${input.action} version=${input.version} target=${os.hostname()}`,
    )
    return {
      ...value,
      package: recipe.package,
      source: recipe.source,
      integrity: release.integrity,
      target: os.hostname(),
      directory: this.directory(input.advisor, input.version),
    }
  }

  async commit(token: string, signal: AbortSignal) {
    const operation = this.prepared.get(token)
    this.prepared.delete(token)
    if (!operation || operation.expiresAt < Date.now())
      throw new AgentInstallError("invalid", "Confirmation expired or already used; prepare the operation again")
    const { advisor, version, action } = operation
    return this.lock(advisor, async () => {
      log.info(`commit advisor=${advisor} action=${action} version=${version}`)
      const destination = this.directory(advisor, version)
      if (action === "remove") {
        const leases = path.join(this.root, "leases", advisor, version)
        for (const file of await fs.readdir(leases).catch(() => [])) {
          const lease = await fs
            .readFile(path.join(leases, file), "utf8")
            .then(JSON.parse)
            .catch(() => undefined)
          if (!lease?.pid)
            throw new AgentInstallError("busy", "Adapter lease is unreadable; retry after active sessions finish")
          try {
            process.kill(lease.pid, 0)
            throw new AgentInstallError("busy", "This adapter version is in use by an active session")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
        }
        await fs.rm(destination, { recursive: true, force: true })
        await fs.rm(leases, { recursive: true, force: true })
      } else {
        try {
          await this.resolve(advisor, version)
          return this.status()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        await fs.mkdir(this.root, { recursive: true })
        const runtime = await this.runtime()
        const { recipe, release } = this.release(advisor, version)
        const stage = path.join(this.root, "staging", randomUUID())
        await fs.mkdir(stage, { recursive: true })
        try {
          await fs.writeFile(
            path.join(stage, "package.json"),
            JSON.stringify({ private: true, name: "opencode-managed-adapter", version: "1.0.0" }),
          )
          await fs.writeFile(path.join(stage, "npmrc"), "")
          await this.runner(
            [
              ...runtime.npm,
              "install",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--omit=dev",
              "--save-exact",
              "--registry=https://registry.npmjs.org",
              `--userconfig=${path.join(stage, "npmrc")}`,
              `--cache=${path.join(this.root, "npm-cache")}`,
              `${recipe.package}@${version}`,
            ],
            stage,
            signal,
          )
          const lock = JSON.parse(await fs.readFile(path.join(stage, "package-lock.json"), "utf8"))
          const installed = lock.packages?.[`node_modules/${recipe.package}`]
          if (installed?.integrity !== release.integrity || installed?.version !== version)
            throw new AgentInstallError(
              "integrity",
              "Downloaded adapter integrity/version does not match the reviewed release",
            )
          const pkg = JSON.parse(
            await fs.readFile(path.join(stage, "node_modules", recipe.package, "package.json"), "utf8"),
          )
          if (pkg.name !== recipe.package || pkg.version !== version)
            throw new AgentInstallError("integrity", "Unexpected adapter package")
          await fs.access(path.join(stage, "node_modules", recipe.package, recipe.entry))
          if (signal.aborted) throw new Error("Installation cancelled")
          await fs.writeFile(
            path.join(stage, "receipt.json"),
            JSON.stringify({
              advisor,
              version,
              integrity: release.integrity,
              installedAt: Date.now(),
            } satisfies Receipt),
          )
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.rename(stage, destination)
          log.info(`installed advisor=${advisor} version=${version} integrity=verified scripts=disabled`)
        } finally {
          await fs.rm(stage, { recursive: true, force: true })
        }
      }
      return this.status()
    })
  }

  async acquire(advisor: string, version: string) {
    return this.lock(advisor, async () => {
      const command = await this.resolve(advisor, version)
      const directory = path.join(this.root, "leases", advisor, version)
      await fs.mkdir(directory, { recursive: true })
      const file = path.join(directory, `${process.pid}-${randomUUID()}.json`)
      await fs.writeFile(file, JSON.stringify({ pid: process.pid }))
      return { command, release: () => fs.rm(file, { force: true }) }
    })
  }
}

let manager: AgentInstallManager | undefined
export const managedAgents = () => (manager ??= new AgentInstallManager())
