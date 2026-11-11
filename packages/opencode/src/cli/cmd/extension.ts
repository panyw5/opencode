import path from "node:path"
import * as prompts from "@clack/prompts"
import npa from "npm-package-arg"
import semver from "semver"
import { Effect, Schema } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Extension } from "@/extension"
import { installation } from "@/extension/install-service"
import { normalizeReleaseUrl } from "@/extension/release"
import {
  InstallError,
  type InstallPreview,
  type InstallRequest,
  type InstallResult,
  type InstallSource,
} from "@/extension/install"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ExtensionID, type Info, type Source } from "@/extension/schema"
import { errorMessage } from "@/util/error"

function extensionID(value: unknown) {
  return Schema.decodeUnknownSync(ExtensionID)(String(value ?? "").trim())
}

function orFail<A>(effect: Effect.Effect<A, Error>) {
  return effect.pipe(Effect.catch((error) => fail(errorMessage(error))))
}

// Only render the public preview, never the process-local capability or raw request URL.
function text(value: string) {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
}

function location(value: string) {
  const url = URL.parse(value)
  if (!url) return text(value)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return text(url.href)
}

function sourceLabel(source: Source) {
  if (source.type === "path") return text(source.path)
  if (source.type === "npm") return `npm:${text(source.spec)} (${location(source.registry)})`
  if (source.type === "release")
    return `release:${location(source.descriptor)} (${text(source.extensionID)}@${text(source.version)}; artifact:${location(source.artifact)}; sha256:${text(source.sha256)}; descriptor-sha256:${text(source.descriptorSha256)})`
  return `${location(source.location)} (sha256:${text(source.sha256)})`
}

export function formatExtensionList(items: Info[]) {
  return items
    .map((item) => `${text(item.id)}\t${text(item.version)}\t${item.state}\t${sourceLabel(item.source)}`)
    .join("\n")
}

export function formatExtensionListJSON(items: Info[]) {
  return JSON.stringify(
    items.map((item) => ({
      ...item,
      source:
        item.source.type === "release"
          ? {
              ...item.source,
              descriptor: location(item.source.descriptor),
              artifact: location(item.source.artifact),
            }
          : item.source.type === "archive"
            ? { ...item.source, location: location(item.source.location) }
            : item.source.type === "npm"
              ? { ...item.source, registry: location(item.source.registry) }
              : item.source,
    })),
    null,
    2,
  )
}

export function extensionInstallSource(
  value: string,
  sha256?: string,
  archiveOnly = false,
  release = false,
): InstallSource {
  if (release) {
    if (sha256 !== undefined) throw new Error("--release and --sha256 are mutually exclusive")
    try {
      return { type: "release", url: normalizeReleaseUrl(value) }
    } catch {
      throw new Error("--release requires a credential-free HTTPS descriptor URL without query or fragment")
    }
  }
  if (!value || /[\s\\\x00-\x1f\x7f]/.test(value)) {
    // Spaces are valid in local filenames, but never in a registry spec or URL.
    if (!value || /[\x00-\x1f\x7f]/.test(value) || !/\.tgz$/i.test(value) || /^\w+:/.test(value))
      throw new Error("Use a registry npm spec, HTTPS .tgz URL or local .tgz file")
  }
  if (/\.zip(?:$|[?#])/i.test(value)) throw new Error("ZIP archives are unsupported; use a prebuilt .tgz archive")
  const url = URL.parse(value)
  if (url?.protocol === "https:") {
    if (!/^https:\/\//i.test(value) || url.username || url.password || !/\.tgz$/i.test(url.pathname))
      throw new Error("A credential-free HTTPS .tgz URL is required")
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(sha256))
      throw new Error("--sha256 must contain 64 hexadecimal digits")
    return { type: "archive", url: value, ...(sha256 === undefined ? {} : { sha256: sha256.toLowerCase() }) }
  }
  if (/\.tgz$/i.test(value) && !/^\w+:/.test(value)) {
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(sha256))
      throw new Error("--sha256 must contain 64 hexadecimal digits")
    return {
      type: "local",
      path: path.resolve(value),
      ...(sha256 === undefined ? {} : { sha256: sha256.toLowerCase() }),
    }
  }
  if (archiveOnly) throw new Error("Updates require --version for npm or --source with an HTTPS/local .tgz archive")
  if (sha256 !== undefined) throw new Error("--sha256 is only supported for .tgz archives")
  let parsed: ReturnType<typeof npa>
  try {
    parsed = npa(value)
  } catch {
    throw new Error("A registry-only npm package spec is required")
  }
  if (
    !parsed.registry ||
    !parsed.name ||
    !["version", "range", "tag"].includes(parsed.type) ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(parsed.name) ||
    parsed.name.split("/").some((part) => part === "." || part === ".." || part === "node_modules")
  )
    throw new Error("A registry-only npm package spec is required; git, aliases and ZIP are unsupported")
  return { type: "npm", spec: value }
}

export function formatInstallPreview(preview: InstallPreview, enable = false, purgeData = false) {
  const lines = [
    `Extension ${preview.kind} preview (no extension code has run)`,
    `ID: ${text(preview.id)}`,
    `Name: ${text(preview.name)}`,
    `Version: ${preview.oldVersion ? `${text(preview.oldVersion)} -> ` : ""}${text(preview.version)}`,
    ...(preview.source.type === "archive"
      ? [
          "Archive digest is pinned automatically. A computed digest does not authenticate the publisher; trust the source before confirming.",
        ]
      : []),
    `Source: ${sourceLabel(preview.source)}`,
    `Permissions: ${preview.permissions.map(text).join(", ") || "none"}`,
    `Permissions added: ${preview.permissionsAdded.map(text).join(", ") || "none"}`,
    `Permissions removed: ${preview.permissionsRemoved.map(text).join(", ") || "none"}`,
  ]
  if (preview.versionChange) lines.push(`Version change: ${preview.versionChange}`)
  if (preview.registryUpgrade)
    lines.push(
      `Registry upgrade: ${preview.registryUpgrade.from} -> ${preview.registryUpgrade.to} (affects the entire registry).`,
      "Stop all older OpenCode processes sharing this registry, data directory or cache directory before confirming; older processes cannot read the upgraded registry.",
      "This is your manual declaration, not machine-verified proof. Uninstalling release extensions will not downgrade the v3 registry.",
    )
  if (preview.kind === "uninstall")
    lines.push(
      purgeData
        ? "Data purge requested; safe cleanup may be deferred."
        : "Settings and extension data will be retained.",
    )
  else {
    lines.push("Trust warning: extensions execute trusted code; declared permissions are not a security sandbox.")
    lines.push(
      preview.kind === "install"
        ? enable
          ? "Enable explicitly requested (--enable)."
          : "New extensions are disabled by default; use --enable to opt in."
        : `Existing enabled state will be preserved (${preview.enable ? "enabled" : "disabled"}).`,
    )
  }
  return lines.join("\n")
}

export function formatInstallResult(result: InstallResult) {
  return [
    `${text(result.id)}: state=${result.state} committed=${result.committed === undefined ? "unknown" : result.committed} synced=${result.synced} cleanupPending=${result.cleanupPending}`,
    ...(result.synced ? [] : ["Runtime synchronization is not confirmed; refresh/restart may be required."]),
    ...(result.cleanupPending ? ["Cleanup is pending; managed files and retained data may remain."] : []),
    ...(result.warnings.length
      ? ["The installation service reported warnings; synchronization/cleanup may need attention."]
      : []),
  ].join("\n")
}

function installFailure(error: unknown) {
  // InstallError messages are curated at the source (no URLs, credentials or
  // paths) and carry per-situation guidance; pass them through verbatim.
  if (error instanceof InstallError) return error.message
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  // Never forward arbitrary transport/runtime errors: they may contain signed URLs or credentials.
  const messages: Record<string, string> = {
    invalid: "Invalid extension operation or source; verify the archive hash, manifest and requested version",
    unauthorized: "Extension operation authorization failed; prepare it again",
    busy: "Too many pending extension operations; retry later",
    expired: "Extension operation expired; prepare it again",
    conflict: "Extension changed or cannot be replaced safely; prepare again or restart the server",
    failed: "Extension installation failed; no registry change was confirmed",
  }
  return typeof code === "string" && Object.hasOwn(messages, code)
    ? messages[code]!
    : "Extension operation failed; check its status before retrying"
}

function installAttempt<A>(run: () => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: installFailure }).pipe(Effect.catch((message) => fail(message)))
}

const mutationsAllowed = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (flags.pure || flags.disableExtensions)
    return yield* fail("Extensions are disabled; extension mutations are not allowed")
})

function applyInstallation(request: InstallRequest, yes: boolean, enable = false, allowRegistryUpgrade = false) {
  return Effect.gen(function* () {
    yield* mutationsAllowed
    // Hold the same process-wide observer/runtime lease as the HTTP service. Do not create a separate runtime.
    yield* Extension.Service
    const installer = installation()
    const preview = yield* installAttempt(() => installer.prepare(request))
    UI.println(formatInstallPreview(preview, enable, request.kind === "uninstall" && !!request.purgeData))
    const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY
    const confirm = (message: string) =>
      Effect.tryPromise({
        try: () => prompts.confirm({ message, initialValue: false }),
        catch: () => "Extension confirmation failed",
      }).pipe(
        Effect.map((answer) => !prompts.isCancel(answer) && answer === true),
        Effect.catch((message) =>
          installAttempt(() => installer.cancel(preview.operationId, preview.token)).pipe(
            Effect.andThen(fail(message)),
          ),
        ),
      )
    let confirmed = yes
    if (!confirmed && interactive) confirmed = yield* confirm(`Confirm extension ${request.kind}?`)
    let acceptRegistryUpgrade = false
    if (confirmed && preview.registryUpgrade) {
      // --yes acknowledges the operation only, never a registry-wide compatibility break.
      acceptRegistryUpgrade = interactive
        ? yield* confirm(
            "All older OpenCode processes sharing this registry, data directory or cache directory are stopped. Confirm this manual declaration (not machine-verified proof) and upgrade the entire registry from v2 to v3; older processes will no longer read it and uninstall will not downgrade it?",
          )
        : yes && allowRegistryUpgrade
      if (!acceptRegistryUpgrade) {
        confirmed = false
        UI.println(
          "Registry upgrade not confirmed. Non-interactive upgrades require both --yes and --allow-registry-upgrade after stopping all older processes sharing this registry, data directory or cache directory. This flag is a manual declaration, not machine-verified proof; uninstall will not downgrade the v3 registry.",
        )
      }
    }
    if (!confirmed) {
      const result = yield* installAttempt(() => installer.cancel(preview.operationId, preview.token))
      if (!yes && !interactive) UI.println("Non-interactive input: use --yes to confirm after reviewing the preview.")
      UI.println(formatInstallResult(result))
      return
    }
    const result = yield* installAttempt(() =>
      installer.commit(
        preview.operationId,
        preview.token,
        request.kind === "uninstall" ? {} : { enable, acceptRegistryUpgrade },
      ),
    )
    UI.println(formatInstallResult(result))
    if (result.committed !== true) return yield* fail("Extension change was not confirmed committed")
  })
}

const InstallCommand = effectCmd({
  command: "install <source>",
  describe: "install an npm package, verified .tgz archive or explicit release descriptor",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        demandOption: true,
        describe: "npm spec, HTTPS/local .tgz archive, or descriptor URL with --release",
      })
      .option("release", { type: "boolean", default: false, describe: "interpret source as a release descriptor URL" })
      .option("sha256", {
        type: "string",
        describe: "optional publisher SHA-256 for archives (incompatible with --release)",
      })
      .option("allow-registry-upgrade", {
        type: "boolean",
        default: false,
        describe:
          "with --yes, declare older processes sharing registry/data/cache stopped; permit irreversible v3 upgrade",
      })
      .option("yes", {
        type: "boolean",
        default: false,
        describe: "explicitly confirm the preview (validation is still required)",
      })
      .option("enable", {
        type: "boolean",
        default: false,
        describe: "explicitly enable the newly installed extension",
      }),
  handler: Effect.fn("Cli.extension.install")(function* (args) {
    yield* mutationsAllowed
    let source: InstallSource
    try {
      source = extensionInstallSource(String(args.source), args.sha256, false, args.release)
    } catch (error) {
      return yield* fail(errorMessage(error))
    }
    yield* applyInstallation({ kind: "install", source }, args.yes, args.enable, args.allowRegistryUpgrade)
  }),
})

const UpdateCommand = effectCmd({
  command: "update <id>",
  describe: "update an extension to an exact npm version, verified archive or current release",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true, describe: "extension id" })
      .option("version", { type: "string", describe: "exact npm version" })
      .option("source", { type: "string", describe: "replacement HTTPS/local .tgz archive" })
      .option("sha256", { type: "string", describe: "optional publisher SHA-256 for replacement archives" })
      .option("release-current", {
        type: "boolean",
        default: false,
        describe: "update from the installed release descriptor (incompatible with version/source/sha256)",
      })
      .option("allow-registry-upgrade", {
        type: "boolean",
        default: false,
        describe:
          "with --yes, declare older processes sharing registry/data/cache stopped; permit irreversible v3 upgrade",
      })
      .option("yes", { type: "boolean", default: false, describe: "explicitly confirm the preview" }),
  handler: Effect.fn("Cli.extension.update")(function* (args) {
    yield* mutationsAllowed
    let id: ExtensionID
    try {
      id = extensionID(args.id)
    } catch {
      return yield* fail("Invalid extension id")
    }
    let request: InstallRequest
    try {
      if (args.releaseCurrent) {
        if (args.version !== undefined || args.source !== undefined || args.sha256 !== undefined)
          throw new Error("--release-current is mutually exclusive with --version, --source and --sha256")
        request = { kind: "update", id, target: "release-current" }
      } else {
        if ((args.version === undefined) === (args.source === undefined))
          throw new Error("Specify exactly one of --version, --source or --release-current")
        if (args.source !== undefined)
          request = { kind: "update", id, source: extensionInstallSource(args.source, args.sha256, true) }
        else {
          if (args.sha256 !== undefined) throw new Error("--sha256 requires --source")
          if (!args.version || semver.valid(args.version) !== args.version)
            throw new Error("--version must be an exact semantic version")
          request = { kind: "update", id, version: args.version }
        }
      }
    } catch (error) {
      return yield* fail(errorMessage(error))
    }
    yield* applyInstallation(request, args.yes, false, args.allowRegistryUpgrade)
  }),
})

const UninstallCommand = effectCmd({
  command: "uninstall <id>",
  describe: "uninstall an extension, retaining data unless explicitly requested",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true, describe: "extension id" })
      .option("purge-data", {
        type: "boolean",
        default: false,
        describe: "request safe removal of retained settings/data (may be deferred)",
      })
      .option("yes", { type: "boolean", default: false, describe: "explicitly confirm the preview" }),
  handler: Effect.fn("Cli.extension.uninstall")(function* (args) {
    yield* mutationsAllowed
    let id: ExtensionID
    try {
      id = extensionID(args.id)
    } catch {
      return yield* fail("Invalid extension id")
    }
    yield* applyInstallation({ kind: "uninstall", id, purgeData: args.purgeData }, args.yes)
  }),
})

const LinkCommand = effectCmd({
  command: "link <directory>",
  describe: "link a local extension directory",
  instance: false,
  builder: (yargs) =>
    yargs.positional("directory", {
      type: "string",
      demandOption: true,
      describe: "extension package directory",
    }),
  handler: Effect.fn("Cli.extension.link")(function* (args) {
    yield* mutationsAllowed
    const directory = path.resolve(String(args.directory))
    const extension = yield* Extension.Service
    const item = yield* orFail(extension.link(directory))
    UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}Linked${UI.Style.TEXT_NORMAL} ${item.id}@${item.version}`)
  }),
})

const ListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list installed and linked extensions",
  instance: false,
  builder: (yargs) =>
    yargs.option("json", {
      type: "boolean",
      default: false,
      describe: "print JSON",
    }),
  handler: Effect.fn("Cli.extension.list")(function* (args) {
    const extension = yield* Extension.Service
    const items = yield* orFail(extension.list())
    if (args.json) {
      process.stdout.write(`${formatExtensionListJSON(items)}\n`)
      return
    }
    if (!items.length) {
      UI.println("No extensions installed or linked")
      return
    }
    UI.println(formatExtensionList(items))
  }),
})

function setEnabledCommand(enabled: boolean) {
  return effectCmd({
    command: `${enabled ? "enable" : "disable"} <id>`,
    describe: `${enabled ? "enable" : "disable"} an extension`,
    instance: false,
    builder: (yargs) =>
      yargs.positional("id", {
        type: "string",
        demandOption: true,
        describe: "extension id",
      }),
    handler: Effect.fn(`Cli.extension.${enabled ? "enable" : "disable"}`)(function* (args) {
      yield* mutationsAllowed
      let id: ExtensionID
      try {
        id = extensionID(args.id)
      } catch {
        return yield* fail(`Invalid extension id: ${String(args.id ?? "")}`)
      }
      const extension = yield* Extension.Service
      const item = yield* orFail(extension.setEnabled(id, enabled))
      UI.println(
        `${enabled ? UI.Style.TEXT_SUCCESS_BOLD : UI.Style.TEXT_DIM_BOLD}${enabled ? "Enabled" : "Disabled"}${UI.Style.TEXT_NORMAL} ${item.id}`,
      )
    }),
  })
}

export const ExtensionCommand = cmd({
  command: "extension",
  aliases: ["ext"],
  describe: "manage OpenCode extensions",
  builder: (yargs) =>
    yargs
      .command(LinkCommand)
      .command(InstallCommand)
      .command(UpdateCommand)
      .command(UninstallCommand)
      .command(ListCommand)
      .command(setEnabledCommand(true))
      .command(setEnabledCommand(false))
      .demandCommand(),
  async handler() {},
})
