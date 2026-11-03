import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ServerAuth } from "@/server/auth"
import { isExtensionAssetPath } from "@/server/shared/extension-asset"
import { isPublicEmbeddedUIAsset, isPublicUIPath } from "@/server/shared/public-ui"
import { EmbeddedWebUI } from "@/server/shared/ui"
import { credentialFromURL, validateRawCredential } from "./authorization"

// Applied exclusively to the UI catch-all, never to API or raw data routes.
export const uiAuthorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const embedded = yield* EmbeddedWebUI
    const flags = yield* RuntimeFlags.Service
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        // Invalid extension resource paths must not fall through to the SPA.
        if (isExtensionAssetPath(url.pathname)) {
          return HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } })
        }
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        const manifest = flags.disableEmbeddedWebUi ? null : yield* embedded.manifest
        if (isPublicEmbeddedUIAsset(request.method, url.pathname, manifest)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config)),
        )
      })
  }),
)
