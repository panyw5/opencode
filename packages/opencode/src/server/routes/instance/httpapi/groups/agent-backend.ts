import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InstallStatus, PrepareInput, PreparedInstall, ProbeInput, ProbeResult } from "@/agent-backend/install-schema"
import { Advisor } from "@/session/external-schema"
import { ChannelOptions } from "@/session/channel-schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { InvalidRequestError, ConflictError, UpstreamError, ForbiddenError } from "../errors"

const errors = [InvalidRequestError, ConflictError, UpstreamError, ForbiddenError] as const
export const AgentBackendApi = HttpApi.make("agent-backend").add(
  HttpApiGroup.make("agentBackend")
    .add(
      HttpApiEndpoint.get("status", "/agent-backend", {
        query: WorkspaceRoutingQuery,
        success: InstallStatus,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "agentBackend.status",
          summary: "Inspect managed ACP adapters on this backend",
        }),
      ),
      HttpApiEndpoint.post("prepare", "/agent-backend/prepare", {
        query: WorkspaceRoutingQuery,
        payload: PrepareInput,
        success: PreparedInstall,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "agentBackend.prepare",
          summary: "Prepare an explicit adapter install/removal confirmation",
        }),
      ),
      HttpApiEndpoint.post("commit", "/agent-backend/commit", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ token: Schema.String }),
        success: InstallStatus,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "agentBackend.commit",
          summary: "Confirm an adapter installation or removal",
        }),
      ),
      HttpApiEndpoint.post("probe", "/agent-backend/probe", {
        query: WorkspaceRoutingQuery,
        payload: ProbeInput,
        success: ProbeResult,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "agentBackend.probe",
          summary: "Explicitly connect, authenticate or send an ACP test message",
        }),
      ),
      HttpApiEndpoint.post("channelOptions", "/agent-backend/channel-options", {
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ advisor: Advisor }),
        success: ChannelOptions,
        error: errors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "agentBackend.channelOptions",
          summary: "List a channel's ACP models and modes before its session exists",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
