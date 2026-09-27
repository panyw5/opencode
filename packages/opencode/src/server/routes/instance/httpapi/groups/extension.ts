import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ExtensionID, Info } from "@/extension/schema"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const ExtensionPaths = {
  list: "/global/extension",
  get: "/global/extension/:id",
  enable: "/global/extension/:id/enable",
  disable: "/global/extension/:id/disable",
} as const

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
    )
    .annotateMerge(
      OpenApi.annotations({ title: "extension", description: "Linked OpenCode web extension management." }),
    )
    .middleware(Authorization),
)
