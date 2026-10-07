import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ExtensionID } from "@/extension/schema"
import { ExtensionRpcError, InvalidRequestError, ServiceUnavailableError, TimeoutError, UnknownError } from "../errors"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const ExtensionRpcPaths = {
  rpc: "/extension/:id/rpc/:method",
} as const

export const ExtensionRpcResult = Schema.Struct({ result: Schema.Unknown }).annotate({
  identifier: "ExtensionRpcResult",
})

// The RPC route is an independent group on RootHttpApi: Authorization comes from
// the root api middleware and workspace routing is explicit via
// WorkspaceRoutingMiddleware. Deliberately no InstanceContextMiddleware — a call
// without ?directory must stay process-level instead of falling back to an
// instance implicitly bound to the server cwd.
//
// The body is parsed by the handler (an optional `{ input?: unknown }` JSON
// object) instead of a declared payload schema: HttpApi rejects body-less POSTs
// even for optional payload schemas, and RPC methods without input must be
// callable without a body. The OpenAPI document still needs to advertise the
// body so SDK clients can send `{ input }`, which is done with the endpoint's
// OpenApi `transform` annotation below — it edits the generated operation only
// and cannot affect runtime body handling, so body-less POSTs keep working.
export const ExtensionRpcApi = HttpApi.make("extension-rpc").add(
  HttpApiGroup.make("extension-rpc")
    .add(
      HttpApiEndpoint.post("rpc", ExtensionRpcPaths.rpc, {
        params: { id: ExtensionID, method: Schema.String },
        query: Schema.Struct(WorkspaceRoutingQueryFields),
        success: described(ExtensionRpcResult, "Extension RPC result"),
        error: [
          HttpApiError.NotFound,
          ExtensionRpcError,
          InvalidRequestError,
          TimeoutError,
          UnknownError,
          ServiceUnavailableError,
        ],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "extension.rpc",
          summary: "Call an extension RPC method",
          description:
            "Invoke a server-side extension RPC handler. The optional JSON body is `{ input?: unknown }`. With ?directory the instance-level handler for that directory is preferred and the process-level handler is the fallback; without it only the process-level handler is consulted.",
          // Matches the handler's `parseRpcBody` contract: an optional JSON
          // object with an optional `input` field. Declared via the OpenApi
          // transform annotation (not a payload schema) because OpenApi.ts
          // always marks payload-driven bodies `required: true`, and a
          // declared payload would make the runtime reject body-less POSTs.
          transform: (operation: Record<string, any>) => ({
            ...operation,
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { input: {} },
                  },
                },
              },
              required: false,
            },
          }),
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "extension-rpc", description: "OpenCode extension server RPC." }))
    .middleware(WorkspaceRoutingMiddleware),
)
