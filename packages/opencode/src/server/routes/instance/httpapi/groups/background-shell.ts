import { BackgroundShell } from "@/background/shell"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/background-shell"

export const BackgroundShellPaths = {
  list: root,
  create: root,
  background: `${root}/:id/background`,
  stop: `${root}/:id`,
} as const

export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.optional(BackgroundShell.ListQuery.fields.sessionID),
})

export const BackgroundShellApi = HttpApi.make("background-shell")
  .add(
    HttpApiGroup.make("background-shell")
      .add(
        HttpApiEndpoint.get("list", BackgroundShellPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(BackgroundShell.Info), "Background shell tasks"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background-shell.list",
            summary: "List background shell tasks",
            description: "List PTY-backed background shell tasks for this workspace or session.",
          }),
        ),
        HttpApiEndpoint.post("create", BackgroundShellPaths.create, {
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          payload: BackgroundShell.CreateInput,
          success: described(BackgroundShell.Info, "Created background shell task"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background-shell.create",
            summary: "Create background shell task",
            description: "Create a PTY-backed background shell task.",
          }),
        ),
        HttpApiEndpoint.post("background", BackgroundShellPaths.background, {
          params: BackgroundShell.Params,
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          success: described(BackgroundShell.Info, "Background shell task"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background-shell.background",
            summary: "Send shell task to background",
            description: "Mark a running supervised shell task as a background shell task.",
          }),
        ),
        HttpApiEndpoint.delete("stop", BackgroundShellPaths.stop, {
          params: BackgroundShell.Params,
          query: Schema.Struct(WorkspaceRoutingQueryFields),
          success: described(Schema.Boolean, "Background shell task stopped"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background-shell.stop",
            summary: "Stop background shell task",
            description: "Stop a running PTY-backed background shell task.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "background-shell", description: "Background shell routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
