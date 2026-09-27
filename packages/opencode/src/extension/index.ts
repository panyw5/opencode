import { randomBytes } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Loaded } from "./manifest"
import { ExtensionRegistry } from "./registry"
import { ExtensionID, type Info } from "./schema"

const token = randomBytes(18).toString("base64url")

function base(manifest: Loaded) {
  return `/extension-asset/${token}/${encodeURIComponent(manifest.id)}/${encodeURIComponent(manifest.versionSegment)}/`
}

function attempt<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

export type Asset = {
  id: ExtensionID
  version: string
  webRoot: string
  source: "path"
}

export interface Interface {
  readonly token: string
  readonly list: () => Effect.Effect<Info[], Error>
  readonly get: (id: ExtensionID) => Effect.Effect<Info, Error>
  readonly link: (directory: string) => Effect.Effect<Info, Error>
  readonly setEnabled: (id: ExtensionID, enabled: boolean) => Effect.Effect<Info, Error>
  readonly asset: (id: ExtensionID, version: string) => Effect.Effect<Asset | undefined, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Extension") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const disabled = () => flags.pure || flags.disableExtensions
    const list = () => (disabled() ? Effect.succeed([]) : attempt(() => ExtensionRegistry.list(base)))
    const get = (id: ExtensionID) =>
      disabled()
        ? Effect.fail(new Error(`Extensions are disabled: ${id}`))
        : attempt(() => ExtensionRegistry.get(id, base))
    const link = (directory: string) =>
      disabled() ? Effect.fail(new Error("Extensions are disabled")) : attempt(() => ExtensionRegistry.link(directory, base))
    const setEnabled = (id: ExtensionID, enabled: boolean) =>
      disabled()
        ? Effect.fail(new Error(`Extensions are disabled: ${id}`))
        : attempt(() => ExtensionRegistry.setEnabled(id, enabled, base))
    const asset = (id: ExtensionID, version: string) =>
      disabled()
        ? Effect.succeed(undefined)
        : attempt(async () => {
            const linked = await ExtensionRegistry.linked(id)
            if (!linked?.row.enabled) return
            if (linked.manifest.versionSegment !== version) return
            return {
              id,
              version,
              webRoot: linked.manifest.webRoot,
              source: "path" as const,
            }
          })

    return Service.of({ token, list, get, link, setEnabled, asset })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(RuntimeFlags.defaultLayer))

export function assetToken() {
  return token
}

export function extensionID(input: string) {
  return ExtensionID.make(input)
}

export * as Extension from "."
