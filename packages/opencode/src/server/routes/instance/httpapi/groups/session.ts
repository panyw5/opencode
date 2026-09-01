import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { LocationID } from "@/project/schema"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ApiNotFoundError, PermissionNotFoundError, SessionBusyError } from "../errors"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  locationID: Schema.optional(LocationID),
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})
export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Struct.omit(SessionSummary.DiffInput.fields, ["sessionID"]),
})
export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  before: Schema.optional(Schema.String),
})
export const StatusMap = Schema.Record(Schema.String, SessionStatus.Info)
export const MathWorkerQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  project: Schema.optional(Schema.String),
})
export const MathDetailKind = Schema.Literals(["facts", "correct", "wrong", "error"])
export const MathDetailsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  project: Schema.String,
  kind: MathDetailKind,
  offset: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})
export const MathVerificationReport = Schema.Struct({
  summary: Schema.String,
  criticalErrors: Schema.Array(Schema.String),
  gaps: Schema.Array(Schema.String),
})
export const MathFactDetail = Schema.Struct({
  kind: Schema.Literal("fact"),
  id: Schema.String,
  factId: Schema.String,
  problemId: Schema.String,
  author: Schema.String,
  predecessors: Schema.Array(Schema.String),
  statement: Schema.String,
  proof: Schema.String,
  intuition: Schema.optional(Schema.String),
  glossaryIntroduces: Schema.Record(Schema.String, Schema.String),
})
export const MathVerificationDetail = Schema.Struct({
  kind: Schema.Literals(["correct", "wrong", "error"]),
  id: Schema.String,
  timestamp: Schema.String,
  workerSessionID: Schema.optional(Schema.String),
  statement: Schema.String,
  proof: Schema.optional(Schema.String),
  evidence: Schema.String,
  factId: Schema.optional(Schema.String),
  writeError: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  report: Schema.optional(MathVerificationReport),
})
export const MathDetailItem = Schema.Union([MathFactDetail, MathVerificationDetail])
export const MathDetailPage = Schema.Struct({
  kind: MathDetailKind,
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  items: Schema.Array(MathDetailItem),
})
export const MathWorkerStatus = Schema.Struct({
  sessionID: Schema.String,
  project: Schema.optional(Schema.String),
  parentSessionID: Schema.optional(Schema.String),
  alive: Schema.Boolean,
  state: Schema.Literals(["running", "stopping", "dead", "missing"]),
  pid: Schema.optional(Schema.Number),
  round: Schema.optional(Schema.Number),
  last_fact_id: Schema.optional(Schema.String),
  last_rc: Schema.optional(Schema.NullOr(Schema.Number)),
  lastHeartbeatAt: Schema.optional(Schema.Number),
  logFile: Schema.optional(Schema.String),
  attachable: Schema.optional(Schema.Boolean),
  restartable: Schema.optional(Schema.Boolean),
  stopRequested: Schema.optional(Schema.Boolean),
  transcriptUpdatedAt: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Number),
  taskUpdatedAt: Schema.optional(Schema.Number),
  taskPreview: Schema.optional(Schema.String),
  factCount: Schema.optional(Schema.Number),
  verificationCorrect: Schema.optional(Schema.Number),
  verificationWrong: Schema.optional(Schema.Number),
  verificationError: Schema.optional(Schema.Number),
  latestVerification: Schema.optional(Schema.String),
  verifierModel: Schema.optional(Schema.String),
})
export const MathWorkerEnsurePayload = Schema.Struct({
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  verifierModel: Schema.optional(Schema.String),
  reEnable: Schema.optional(Schema.Boolean),
})
export const MathWorkerStopPayload = Schema.Struct({ force: Schema.optional(Schema.Boolean) })
export const MathWorkerTaskInfo = Schema.Struct({
  sessionID: Schema.String,
  project: Schema.String,
  task: Schema.String,
  updatedAt: Schema.Number,
})
export const MathWorkerTaskPayload = Schema.Struct({ task: Schema.String })
export const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  permission: Schema.optional(Permission.Ruleset),
  injectTaskContext: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Schema.NullOr(Session.ArchivedTimestamp)),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const InitPayload = Schema.Struct({
  modelID: ModelID,
  providerID: ProviderID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: Permission.Reply,
})
export const AdvisorInterventionPayload = Schema.Struct({
  callID: Schema.String,
})
export const AdvisorInterventionMessagePayload = Schema.Struct({
  callID: Schema.String,
  message: Schema.String,
})
export const HookControlPayload = Plugin.HookControlInput

export const SessionPaths = {
  list: root,
  status: `${root}/status`,
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  mathWorkers: `${root}/:sessionID/math-workers`,
  mathDetails: `${root}/:sessionID/math-details`,
  mathWorkerEnsure: `${root}/:sessionID/math-workers/:workerID/ensure`,
  mathWorkerStop: `${root}/:sessionID/math-workers/:workerID/stop`,
  mathWorkerTask: `${root}/:sessionID/math-workers/:workerID/task`,
  todo: `${root}/:sessionID/todo`,
  diff: `${root}/:sessionID/diff`,
  messages: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  hooks: `${root}/:sessionID/hooks`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
  summarize: `${root}/:sessionID/summarize`,
  generateTitle: `${root}/:sessionID/generate_title`,
  prompt: `${root}/:sessionID/message`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  command: `${root}/:sessionID/command`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permissions: `${root}/:sessionID/permissions/:permissionID`,
  deleteMessage: `${root}/:sessionID/message/:messageID`,
  deletePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  updatePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  advisorInterventionStart: `${root}/:sessionID/advisor-intervention/start`,
  advisorInterventionMessage: `${root}/:sessionID/advisor-intervention/message`,
  advisorInterventionFinish: `${root}/:sessionID/advisor-intervention/finish`,
} as const

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Session.Info), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.list",
            summary: "List sessions",
            description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
          }),
        ),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusMap, "Get session status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.status",
            summary: "Get session status",
            description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Get session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Get session",
            description: "Retrieve detailed information about a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Session.Info), "List of children"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.children",
            summary: "Get session children",
            description: "Retrieve all child sessions that were forked from the specified parent session.",
          }),
        ),
        HttpApiEndpoint.get("mathWorkers", SessionPaths.mathWorkers, {
          params: { sessionID: SessionID },
          query: MathWorkerQuery,
          success: described(Schema.Array(MathWorkerStatus), "List Math Mode workers"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mathWorkers",
            summary: "Get Math Mode workers",
            description: "Reconcile durable math-worker child sessions with detached process status.",
          }),
        ),
        HttpApiEndpoint.get("mathDetails", SessionPaths.mathDetails, {
          params: { sessionID: SessionID },
          query: MathDetailsQuery,
          success: described(MathDetailPage, "Math Mode fact and verification details"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mathDetails",
            summary: "Get Math Mode details",
            description: "List accepted facts or proof verification records for a Math Mode project.",
          }),
        ),
        HttpApiEndpoint.post("mathWorkerEnsure", SessionPaths.mathWorkerEnsure, {
          params: { sessionID: SessionID, workerID: SessionID },
          query: MathWorkerQuery,
          payload: Schema.optional(MathWorkerEnsurePayload),
          success: described(MathWorkerStatus, "Ensured Math Mode worker"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mathWorkerEnsure",
            summary: "Ensure Math Mode worker",
            description:
              "Restart an unexpectedly dead worker using its existing durable session identity. A deliberate stop requires explicit reEnable.",
          }),
        ),
        HttpApiEndpoint.post("mathWorkerStop", SessionPaths.mathWorkerStop, {
          params: { sessionID: SessionID, workerID: SessionID },
          query: MathWorkerQuery,
          payload: Schema.optional(MathWorkerStopPayload),
          success: described(MathWorkerStatus, "Stopped Math Mode worker"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mathWorkerStop",
            summary: "Stop Math Mode worker",
            description: "Request a round-boundary stop or force-kill the detached worker process group.",
          }),
        ),
        HttpApiEndpoint.get("mathWorkerTaskGet", SessionPaths.mathWorkerTask, {
          params: { sessionID: SessionID, workerID: SessionID },
          query: MathWorkerQuery,
          success: described(MathWorkerTaskInfo, "Math Mode worker task"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mathWorkerTaskGet",
            summary: "Get Math Mode worker task",
            description: "Read the durable TASK body used at the start of each worker round.",
          }),
        ),
        HttpApiEndpoint.put("mathWorkerTaskUpdate", SessionPaths.mathWorkerTask, {
          params: { sessionID: SessionID, workerID: SessionID },
          query: MathWorkerQuery,
          payload: MathWorkerTaskPayload,
          success: described(MathWorkerTaskInfo, "Updated Math Mode worker task"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mathWorkerTaskUpdate",
            summary: "Update Math Mode worker task",
            description: "Atomically replace the durable TASK body for the worker's next round.",
          }),
        ),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Info), "Todo list"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.todo",
            summary: "Get session todos",
            description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
          }),
        ),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: { sessionID: SessionID },
          query: DiffQuery,
          success: described(Schema.Array(Snapshot.FileDiff), "Successfully retrieved diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diff",
            summary: "Get message diff",
            description: "Get the file changes (diff) that resulted from a specific user message in the session.",
          }),
        ),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: { sessionID: SessionID },
          query: MessagesQuery,
          success: described(Schema.Array(MessageV2.WithParts), "List of messages"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.messages",
            summary: "Get session messages",
            description: "Retrieve all messages in a session, including user prompts and AI responses.",
          }),
        ),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(MessageV2.WithParts, "Message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Session.CreateInput],
          success: described(Session.Info, "Successfully created session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Create session",
            description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.delete",
            summary: "Delete session",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
          }),
        ),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Session.Info, "Successfully updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Update session",
            description: "Update properties of an existing session, such as title or other metadata.",
          }),
        ),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: Schema.optional(ForkPayload),
          success: described(Session.Info, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description: "Create a new session by forking an existing session at a specific message point.",
          }),
        ),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Aborted session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.abort",
            summary: "Abort session",
            description: "Abort an active session and stop any ongoing AI processing or command execution.",
          }),
        ),
        HttpApiEndpoint.get("hooks", SessionPaths.hooks, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Plugin.HookControl), "List session hook controls"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.hooks",
            summary: "List session hook controls",
            description:
              "List temporary hook controls for a session. Controls are in-memory and only affect the current server process.",
          }),
        ),
        HttpApiEndpoint.post("hookControl", SessionPaths.hooks, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: HookControlPayload,
          success: described(Schema.Array(Plugin.HookControl), "Updated session hook controls"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.hookControl",
            summary: "Set session hook control",
            description:
              "Enable or disable a plugin hook for this session. Omitting plugin targets all plugins; event narrows event hooks to one event type.",
          }),
        ),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: InitPayload,
          success: described(Schema.Boolean, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.init",
            summary: "Initialize session",
            description:
              "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
          }),
        ),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully shared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share",
            summary: "Share session",
            description: "Create a shareable link for a session, allowing others to view the conversation.",
          }),
        ),
        HttpApiEndpoint.delete("unshare", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully unshared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare",
            summary: "Unshare session",
            description: "Remove the shareable link for a session, making it private again.",
          }),
        ),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SummarizePayload,
          success: described(Schema.Boolean, "Summarized session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.summarize",
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
          }),
        ),
        HttpApiEndpoint.post("generateTitle", SessionPaths.generateTitle, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Generated session title"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.generate_title",
            summary: "Generate session title",
            description:
              "Generate or regenerate a session title from the session's user prompts using the title agent.",
          }),
        ),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Create and send a new message to a session, streaming the AI response.",
          }),
        ),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(HttpApiSchema.NoContent, "Prompt accepted"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_async",
            summary: "Send async message",
            description:
              "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
          }),
        ),
        HttpApiEndpoint.post("advisorInterventionStart", SessionPaths.advisorInterventionStart, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AdvisorInterventionPayload,
          success: described(Schema.Boolean, "Advisor intervention started"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.advisor_intervention_start",
            summary: "Start advisor intervention",
            description: "Keep an active Codex or Claude consultation open for user interaction.",
          }),
        ),
        HttpApiEndpoint.post("advisorInterventionMessage", SessionPaths.advisorInterventionMessage, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AdvisorInterventionMessagePayload,
          success: described(Schema.Boolean, "Advisor message accepted"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.advisor_intervention_message",
            summary: "Send advisor intervention message",
            description: "Send a user message to an intervened Codex or Claude consultation.",
          }),
        ),
        HttpApiEndpoint.post("advisorInterventionFinish", SessionPaths.advisorInterventionFinish, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AdvisorInterventionPayload,
          success: described(Schema.Boolean, "Advisor intervention finished"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.advisor_intervention_finish",
            summary: "Finish advisor intervention",
            description: "Return an intervened consultation to the OpenCode agent after its current turn completes.",
          }),
        ),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Send command",
            description: "Send a new command to a session for execution by the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ShellPayload,
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description: "Execute a shell command within the session context and return the AI's response.",
          }),
        ),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: RevertPayload,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert",
            summary: "Revert message",
            description:
              "Revert a specific message in a session, undoing its effects and restoring the previous state.",
          }),
        ),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert",
            summary: "Restore reverted messages",
            description: "Restore all previously reverted messages in a session.",
          }),
        ),
        HttpApiEndpoint.post("permissionRespond", SessionPaths.permissions, {
          params: { sessionID: SessionID, permissionID: PermissionID },
          query: WorkspaceRoutingQuery,
          payload: PermissionResponsePayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.respond",
            summary: "Respond to permission",
            description: "Approve or deny a permission request from the AI assistant.",
            deprecated: true,
          }),
        ),
        HttpApiEndpoint.delete("deleteMessage", SessionPaths.deleteMessage, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.deleteMessage",
            summary: "Delete message",
            description:
              "Permanently delete a specific message and all of its parts from a session without reverting file changes.",
          }),
        ),
        HttpApiEndpoint.delete("deletePart", SessionPaths.deletePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.delete",
            description: "Delete a part from a message.",
          }),
        ),
        HttpApiEndpoint.patch("updatePart", SessionPaths.updatePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          payload: MessageV2.Part,
          success: described(MessageV2.Part, "Successfully updated part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.update",
            description: "Update a part in a message.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session",
          description: "Experimental HttpApi session routes.",
        }),
      )
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
