import { BrowserTicket } from "@/browser/ticket"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { BrowserForbiddenError } from "../errors"
import { described } from "./metadata"

const root = "/browser/bridge"

export const BrowserApi = HttpApi.make("browser")
  .add(
    HttpApiGroup.make("browser")
      .add(
        HttpApiEndpoint.post("connectToken", `${root}/ticket`, {
          query: WorkspaceRoutingQuery,
          success: described(BrowserTicket.ConnectToken, "WebSocket connect token"),
          error: BrowserForbiddenError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.connectToken",
            summary: "Create browser bridge WebSocket token",
            description: "Create a short-lived ticket for opening the browser bridge WebSocket connection.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "browser", description: "Browser bridge routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )

export const BrowserConnectApi = HttpApi.make("browser-connect").add(
  HttpApiGroup.make("browser-connect")
    .add(
      HttpApiEndpoint.get("connect", root, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Connected bridge"),
        error: HttpApiError.Forbidden,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.connect",
          summary: "Connect to the browser bridge",
          description:
            "Establish a WebSocket connection between the opencode server and the desktop browser controller.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "browser", description: "Browser bridge websocket route." })),
)
