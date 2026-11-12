import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ExtensionID, Info } from "@/extension/schema"
import { Authorization } from "../middleware/authorization"
import { ConflictError } from "../errors"
import { described } from "./metadata"

export const ExtensionPaths = {
  list: "/global/extension",
  get: "/global/extension/:id",
  enable: "/global/extension/:id/enable",
  disable: "/global/extension/:id/disable",
  retry: "/global/extension/:id/retry",
  settings: "/global/extension/:id/settings",
} as const

/**
 * Partial settings patch for an extension. Keys and value types are validated
 * against the extension manifest's `contributes.settings` declarations by the
 * registry, so the transport stays open (`Record<string, unknown>`); an
 * explicit `null` value resets a setting back to its manifest default.
 */
export const ExtensionSettingsPatch = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "ExtensionSettingsPatch",
  description: "Partial extension settings patch; `null` resets a key to its manifest default",
})

export const ExtensionApi = HttpApi.make("extension").add(
  HttpApiGroup.make("extension")
    .add(
      HttpApiEndpoint.get("list", ExtensionPaths.list, {
        success: described(Schema.Array(Info), "Linked extensions"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "extension.list",
          summary: "List extensions",
          description: "List linked OpenCode extensions and their web contributions.",
        }),
      ),
      HttpApiEndpoint.get("get", ExtensionPaths.get, {
        params: { id: ExtensionID },
        success: described(Info, "Linked extension"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "extension.get", summary: "Get extension" })),
      HttpApiEndpoint.post("enable", ExtensionPaths.enable, {
        params: { id: ExtensionID },
        success: described(Info, "Enabled extension"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "extension.enable", summary: "Enable extension" })),
      HttpApiEndpoint.post("disable", ExtensionPaths.disable, {
        params: { id: ExtensionID },
        success: described(Info, "Disabled extension"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "extension.disable", summary: "Disable extension" })),
      HttpApiEndpoint.post("retry", ExtensionPaths.retry, {
        params: { id: ExtensionID },
        success: described(Info, "Extension scheduled for retry"),
        error: [HttpApiError.NotFound, ConflictError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "extension.retry",
          summary: "Retry extension runtime",
          description:
            "Clear a retryable runtime error and rebuild hooks. Disabled, mutating, or restart-blocked extensions cannot be retried.",
        }),
      ),
      HttpApiEndpoint.patch("updateSettings", ExtensionPaths.settings, {
        params: { id: ExtensionID },
        payload: ExtensionSettingsPatch,
        success: described(Info, "Updated extension settings"),
        error: [HttpApiError.NotFound, HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "extension.settings.update",
          summary: "Update extension settings",
          description:
            "Apply a partial settings patch to a linked extension. Unknown keys, wrong value types and enum violations are rejected; secret values are returned masked.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "extension", description: "Linked OpenCode web extension management." }),
    )
    .middleware(Authorization),
)
