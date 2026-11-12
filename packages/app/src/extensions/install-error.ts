import type { InstallationTranslationKey } from "../pages/install-actions-state"

// Only explicitly curated installation diagnostics may cross into the UI.
// Never stringify SDK exceptions: they can contain confirmation headers/tokens.
// `message` is the exact backend string; `key` localizes it for the dialog;
// `category` is a fixed ASCII slug that is safe to write into a log line.
const diagnostics: ReadonlyArray<{
  message: string
  key: InstallationTranslationKey
  category: string
}> = [
  {
    message: "Extension is already installed",
    key: "config.extensions.install.diagAlreadyInstalled",
    category: "already-installed",
  },
  {
    message: "Extension is not installed",
    key: "config.extensions.install.diagNotInstalled",
    category: "not-installed",
  },
  {
    message: "Development links cannot be updated by the installer",
    key: "config.extensions.install.diagDevLink",
    category: "dev-link",
  },
  {
    message: "Extension requires a server restart before replacement",
    key: "config.extensions.install.diagRestart",
    category: "restart-required",
  },
  {
    message:
      "Archive download blocked by non-public DNS (proxy/fake-IP). Use desktop archive download or a local .tgz file.",
    key: "config.extensions.install.diagArchiveDns",
    category: "archive-dns",
  },
  {
    message: "Archive SHA-256 verification failed; no extension was installed",
    key: "config.extensions.install.diagArchiveSha",
    category: "archive-sha",
  },
  {
    message: "Archive download failed; check the network/proxy or use a local .tgz file",
    key: "config.extensions.install.diagArchiveNetwork",
    category: "archive-network",
  },
  {
    message: "Archive digest does not match the release descriptor",
    key: "config.extensions.install.diagArchiveDigest",
    category: "archive-digest",
  },
  {
    message: "Archive exceeds the 100 MiB download limit",
    key: "config.extensions.install.diagArchiveSize",
    category: "archive-size",
  },
  {
    message: "Extension server changed during archive download",
    key: "config.extensions.install.diagServerChanged",
    category: "server-changed",
  },
  {
    message: "Extension server changed during archive staging",
    key: "config.extensions.install.diagServerChanged",
    category: "server-changed",
  },
  {
    message: "Release descriptor is not valid JSON; use a raw stable.json URL, not a web page",
    key: "config.extensions.install.diagDescriptorJson",
    category: "descriptor-json",
  },
  {
    message: "Release descriptor does not match schema version 1",
    key: "config.extensions.install.diagDescriptorSchema",
    category: "descriptor-schema",
  },
  {
    message: "Release descriptor exceeds the 64 KiB download limit",
    key: "config.extensions.install.diagDescriptorSize",
    category: "descriptor-size",
  },
  {
    message: "Release descriptor download failed; check the network/proxy",
    key: "config.extensions.install.diagDescriptorNetwork",
    category: "descriptor-network",
  },
  {
    message: "Extension storage is locked by an interrupted process; unlock it to continue",
    key: "config.extensions.install.diagLocked",
    category: "storage-locked",
  },
]

const whitelist = new Map(diagnostics.map((diagnostic) => [diagnostic.message, diagnostic]))

export class ExtensionInstallationError extends Error {
  override readonly name = "ExtensionInstallationError"
}

/**
 * The exact whitelisted backend message, or undefined for anything else.
 * SDK `{ throwOnError: true }` clients re-throw the decoded body as an Error
 * with the raw body kept under `cause`; that body passes the same curated
 * whitelist, so a curated server diagnostic survives while transport noise,
 * HTML error pages, and anything echoing headers or capabilities stays out
 * of the UI.
 */
export function installationDiagnostic(error: unknown): string | undefined {
  if (error instanceof ExtensionInstallationError) return error.message
  if (!error || typeof error !== "object") return
  const value = error as {
    message?: unknown
    data?: { message?: unknown }
    cause?: { body?: unknown }
  }
  const direct = value.data?.message ?? value.message
  if (typeof direct === "string" && whitelist.has(direct)) return direct
  const body = value.cause?.body
  if (!body || typeof body !== "object") return
  const bodyValue = body as { message?: unknown; data?: { message?: unknown } }
  const bodyMessage = bodyValue.data?.message ?? bodyValue.message
  if (typeof bodyMessage === "string" && whitelist.has(bodyMessage)) return bodyMessage
}

/** Localized diagnostic for the dialog; unmapped errors produce undefined. */
export function installationDiagnosticKey(error: unknown): InstallationTranslationKey | undefined {
  const message = installationDiagnostic(error)
  return message ? whitelist.get(message)?.key : undefined
}

/** Fixed ASCII category for logs; never echoes the raw error text or any secret. */
export function installationDiagnosticCategory(error: unknown): string {
  const message = installationDiagnostic(error)
  return message ? (whitelist.get(message)?.category ?? "none") : "none"
}
