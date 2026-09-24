import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"

const Params = Schema.Struct({ sessionID: Schema.String, artifactID: Schema.String })
const Query = Schema.Struct({ ...WorkspaceRoutingQueryFields, variant: Schema.optional(Schema.Literals(["thumbnail", "original"])) })

export const PresentationApi = HttpApi.make("presentation").add(
  HttpApiGroup.make("presentation")
    .add(
      HttpApiEndpoint.get("get", "/session/:sessionID/presentation/:artifactID", {
        params: Params,
        query: Query,
        error: [HttpApiError.NotFound],
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" })),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "session.presentation", summary: "Read presented file", description: "Read an immutable session presentation artifact." }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
