import { expect, test } from "bun:test"
import type { ExtensionHost, ExtensionService, RpcHandler, ServerExtension } from "@opencode-ai/extension-kit/server"
import type { ExtensionContext, WebExtension } from "@opencode-ai/extension-kit/web"
import type {
  AuthHook,
  Hooks,
  PluginInput,
  ProviderHook,
  ToolContext,
  ToolDefinition,
  WorkspaceAdapter,
} from "@opencode-ai/plugin"

// Exhaustive against the authoring APIs: an added member must get an explicit transfer decision.
// These are protocol requirements, not claims that the adapters have been implemented.
type Transfer = "value" | "handle" | "mutable-output" | "schema-codec" | "managed-process" | "frontend-realm"
const matrix = {
  server: {
    id: "value",
    activate: "handle",
    server: "handle",
  } satisfies Record<keyof ServerExtension, Transfer>,
  service: {
    rpc: "handle",
    dispose: "handle",
  } satisfies Record<keyof ExtensionService, Transfer>,
  host: {
    id: "value",
    version: "value",
    dataDir: "value",
    cacheDir: "value",
    serverUrl: "value",
    settings: "handle",
    setTimeout: "handle",
    setInterval: "handle",
    emit: "handle",
    log: "handle",
  } satisfies Record<keyof ExtensionHost, Transfer>,
  settings: {
    get: "handle",
    onDidChange: "handle",
  } satisfies Record<keyof ExtensionHost["settings"], Transfer>,
  rpcContext: {
    directory: "value",
    signal: "handle",
  } satisfies Record<keyof Parameters<RpcHandler>[1], Transfer>,
  pluginInput: {
    client: "handle",
    project: "value",
    directory: "value",
    worktree: "value",
    experimental_workspace: "handle",
    serverUrl: "value",
    $: "managed-process",
  } satisfies Record<keyof PluginInput, Transfer>,
  workspace: {
    name: "value",
    description: "value",
    configure: "handle",
    create: "handle",
    remove: "handle",
    target: "handle",
  } satisfies Record<keyof WorkspaceAdapter, Transfer>,
  hooks: {
    dispose: "handle",
    event: "handle",
    config: "mutable-output",
    tool: "schema-codec",
    auth: "handle",
    provider: "handle",
    "chat.message": "mutable-output",
    "chat.params": "mutable-output",
    "chat.headers": "mutable-output",
    "permission.ask": "mutable-output",
    "command.execute.before": "mutable-output",
    "tool.execute.before": "mutable-output",
    "shell.env": "mutable-output",
    "tool.execute.after": "mutable-output",
    "assistant.response.before": "mutable-output",
    "assistant.response.after": "mutable-output",
    "experimental.chat.messages.transform": "mutable-output",
    "experimental.chat.system.transform": "mutable-output",
    "experimental.session.compacting": "mutable-output",
    "experimental.compaction.autocontinue": "mutable-output",
    "experimental.text.complete": "mutable-output",
    "tool.definition": "mutable-output",
  } satisfies Record<keyof Hooks, Transfer>,
  auth: {
    provider: "value",
    loader: "handle",
    methods: "handle",
  } satisfies Record<keyof AuthHook, Transfer>,
  provider: {
    id: "value",
    models: "handle",
  } satisfies Record<keyof ProviderHook, Transfer>,
  tool: {
    description: "value",
    args: "schema-codec",
    execute: "handle",
  } satisfies Record<keyof ToolDefinition, Transfer>,
  toolContext: {
    sessionID: "value",
    messageID: "value",
    agent: "value",
    directory: "value",
    worktree: "value",
    abort: "handle",
    metadata: "handle",
    ask: "handle",
  } satisfies Record<keyof ToolContext, Transfer>,
  web: {
    id: "value",
    apiVersion: "value",
    activate: "frontend-realm",
  } satisfies Record<keyof WebExtension, Transfer>,
  webContext: {
    id: "value",
    version: "value",
    fileViewers: "frontend-realm",
    toolRenderers: "frontend-realm",
    panels: "frontend-realm",
    commands: "frontend-realm",
    assets: "handle",
    log: "handle",
    rpc: "handle",
    events: "handle",
    settings: "handle",
  } satisfies Record<keyof ExtensionContext, Transfer>,
}

test("lifecycle transfer decisions preserve mutable outputs, callbacks and realm-owned UI", () => {
  expect(matrix.hooks["chat.message"]).toBe("mutable-output")
  expect(matrix.hooks["tool.execute.after"]).toBe("mutable-output")
  expect(matrix.tool.args).toBe("schema-codec")
  expect(matrix.toolContext.abort).toBe("handle")
  expect(matrix.toolContext.metadata).toBe("handle")
  expect(matrix.auth.methods).toBe("handle")
  expect(matrix.pluginInput.$).toBe("managed-process")
  expect(matrix.webContext.fileViewers).toBe("frontend-realm")
})
