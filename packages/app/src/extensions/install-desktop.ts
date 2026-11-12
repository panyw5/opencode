import { fetchArtifact, fetchReleaseDocument } from "./catalog-install"
import { hostCompatibility } from "./catalog"
import { ExtensionInstallationError } from "./install-error"
import { createLocalInstallationOperations } from "./install-local"
import type { InstallationOperations, PreparedInstallation } from "../pages/install-actions-state"

type Invoke = Parameters<typeof createLocalInstallationOperations>[0]
export type DesktopArchiveBridge = {
  invoke: Invoke
  stage(bytes: Uint8Array): Promise<{ ok: true; value: { path: string } } | { ok: false; error: { message: string } }>
  cleanup(path: string): Promise<unknown>
}

/** Desktop downloads use Chromium/system proxy; remote servers never mutate the local registry. */
export function createDesktopArchiveOperations(input: {
  fallback: InstallationOperations
  bridge: DesktopArchiveBridge
  local(): boolean
  connection(): unknown
  releaseURL?(id: string): string | undefined
  download?(url: string): Promise<Uint8Array>
  fetch?: typeof fetch
  /** Running host build version, used to gate a descriptor's declared engines range. */
  hostVersion?(): string | undefined
}): InstallationOperations {
  const local = createLocalInstallationOperations(input.bridge.invoke)
  const owners = new WeakMap<PreparedInstallation, InstallationOperations>()
  const owner = (prepared: PreparedInstallation) => owners.get(prepared) ?? input.fallback
  return {
    async prepareInstallation(request) {
      const source = "source" in request ? request.source : undefined
      const releaseUpdate = request.kind === "update" && "target" in request && request.target === "release-current"
      if (!input.local() || (!releaseUpdate && source?.type !== "archive" && source?.type !== "release")) {
        const prepared = await input.fallback.prepareInstallation(request)
        owners.set(prepared, input.fallback)
        return prepared
      }
      const connection = input.connection()
      const current = () => input.local() && input.connection() === connection
      const url = releaseUpdate ? input.releaseURL?.(request.id) : source?.type === "release" ? source.url : undefined
      if (releaseUpdate && !url)
        throw new ExtensionInstallationError("A release update requires an installed release source")
      console.info(
        `[extension-install] desktop download start kind=${request.kind} source=${url ? "release" : "archive"}`,
      )
      const release = url ? await fetchReleaseDocument(url, input.fetch) : undefined
      if (release) {
        const compat = hostCompatibility(release.descriptor.engines, input.hostVersion?.())
        if (!compat.ok) {
          console.warn(`[extension-install] release incompatible id=${release.descriptor.id} range=${compat.range ?? "?"}`)
          throw new ExtensionInstallationError(
            `Extension requires opencode ${compat.range}; this build is ${input.hostVersion?.() ?? "unknown"}`,
          )
        }
      }
      if (!current()) throw new ExtensionInstallationError("Extension server changed during archive download")
      const artifact =
        release?.descriptor ??
        (source?.type === "archive"
          ? {
              id: "id" in request ? request.id : "",
              version: "",
              artifactUrl: source.url,
              artifactSha256: source.sha256,
            }
          : undefined)
      if (!artifact) throw new ExtensionInstallationError("A release update requires an installed release source")
      const { bytes, digest } = await fetchArtifact(artifact, input.fetch, input.download)
      if (!current()) throw new ExtensionInstallationError("Extension server changed during archive download")
      const staged = await input.bridge.stage(bytes)
      if (!staged.ok) throw new Error(staged.error.message)
      try {
        if (!current()) throw new ExtensionInstallationError("Extension server changed during archive staging")
        console.info(
          `[extension-install] desktop bytes verified size=${bytes.byteLength} source=${release ? "release" : "archive"}; preparing preview`,
        )
        const prepared = release
          ? await (async () => {
              const response = await input.bridge.invoke("prepare", {
                request,
                release: {
                  url: release.url,
                  descriptor: release.document,
                  signature: release.signature,
                  path: staged.value.path,
                },
              })
              if (!response.ok) throw new Error(response.error.message)
              return response.value as PreparedInstallation
            })()
          : await (async () => {
              const response = await input.bridge.invoke("prepare", {
                request,
                archive: { path: staged.value.path, sha256: digest },
              })
              if (!response.ok) throw new Error(response.error.message)
              return response.value as PreparedInstallation
            })()
        if (!current()) {
          await local.cancelInstallation(prepared).catch(() => {})
          throw new ExtensionInstallationError("Extension server changed during archive staging")
        }
        owners.set(prepared, local)
        console.info(
          `[extension-install] desktop preview ready kind=${prepared.kind} id=${prepared.id} version=${prepared.version} source=${prepared.source?.type ?? "unknown"}`,
        )
        return prepared
      } finally {
        await input.bridge.cleanup(staged.value.path).catch(() => {})
      }
    },
    commitInstallation: (prepared, options) => owner(prepared).commitInstallation(prepared, options),
    installationStatus: (prepared) => owner(prepared).installationStatus(prepared),
    cancelInstallation: (prepared) => owner(prepared).cancelInstallation(prepared),
  }
}
