import { createInterface } from "node:readline"
import { appendFileSync } from "node:fs"

let sessionId = `acp-fixture-${process.pid}`
let turn = 0
let pendingPermission
let authenticated = false
let mcpNames = []
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n")
const reply = (id, result) => send({ id, result })
const update = (value, id = sessionId) => send({ method: "session/update", params: { sessionId: id, update: value } })
const text = (value) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } })
const record = (value) => {
  if (process.env.ACP_FIXTURE_LOG) appendFileSync(process.env.ACP_FIXTURE_LOG, JSON.stringify(value) + "\n")
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  record(request)
  const { id, method, params } = request
  if (!method && id === "permission") {
    text(`PERMISSION_${request.result.outcome.optionId ?? request.result.outcome.outcome}`)
    reply(pendingPermission, { stopReason: "end_turn" })
  } else if (method === "initialize") {
    reply(id, {
      protocolVersion: process.env.ACP_FIXTURE_VERSION ? 999 : 1,
      agentCapabilities: { loadSession: process.env.ACP_FIXTURE_LOAD_SESSION === "1" },
      agentInfo: { name: "fixture", version: "1" },
      ...(process.env.ACP_FIXTURE_AUTH
        ? {
            authMethods: [
              {
                id: "fixture-login",
                name: "Fixture login",
                ...(process.env.ACP_FIXTURE_AUTH_KIND === "terminal" ? { type: "terminal", args: ["login"] } : {}),
                ...(process.env.ACP_FIXTURE_AUTH_KIND === "env_var"
                  ? { type: "env_var", vars: [{ name: "FIXTURE_SECRET", secret: true }] }
                  : {}),
              },
            ],
          }
        : {}),
    })
  } else if (method === "session/load") {
    sessionId = params.sessionId
    mcpNames = (params.mcpServers ?? []).map((server) => server.name)
    reply(id, {
      configOptions: [],
      models: {
        currentModelId: "fixture/default",
        availableModels: [
          { modelId: "fixture/default", name: "Default" },
          { modelId: "fixture/other", name: "Other" },
        ],
      },
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "code", name: "Code" },
        ],
      },
    })
  } else if (method === "session/new") {
    if (process.env.ACP_FIXTURE_AUTH && !authenticated) {
      send({ id, error: { code: -32000, message: "Authentication required" } })
      continue
    }
    mcpNames = (params.mcpServers ?? []).map((server) => server.name)
    if (process.env.ACP_FIXTURE_CONFIG_OPTIONS) {
      reply(id, {
        sessionId,
        configOptions: [
          {
            id: "model",
            category: "model",
            name: "Model",
            type: "select",
            currentValue: "fixture/default",
            options: [
              {
                group: "fixture",
                name: "Fixture",
                options: [
                  { value: "fixture/default", name: "Default" },
                  { value: "fixture/other", name: "Other" },
                ],
              },
            ],
          },
        ],
      })
      continue
    }
    reply(id, {
      sessionId,
      models: {
        currentModelId: "fixture/default",
        availableModels: [
          { modelId: "fixture/default", name: "Default" },
          { modelId: "fixture/other", name: "Other" },
        ],
      },
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "code", name: "Code" },
        ],
      },
    })
  } else if (method === "authenticate") {
    authenticated = true
    reply(id, {})
  } else if (method === "session/set_model" || method === "session/set_mode") reply(id, {})
  else if (method === "session/set_config_option") reply(id, { configOptions: [] })
  else if (method === "session/cancel") record({ cancelled: true })
  else if (method === "session/prompt") {
    const prompt = params.prompt[0].text
    turn++
    if (prompt === "exit") process.exit(3)
    if (prompt === "bad") {
      process.stdout.write("not-json\n")
      continue
    }
    if (prompt === "mcp") {
      text(`MCP=${mcpNames.join(",") || "none"}`)
      reply(id, { stopReason: "end_turn" })
      continue
    }
    if (prompt === "loaded") {
      text(`SESSION=${sessionId}`)
      reply(id, { stopReason: "end_turn" })
      continue
    }
    if (prompt === "permission" || prompt.endsWith("\n\npermission")) {
      pendingPermission = id
      send({
        id: "permission",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "read-1",
            title: "Read fixture",
            kind: "read",
            locations: process.env.ACP_FIXTURE_EMPTY_LOCATIONS ? [] : [{ path: process.cwd() }],
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      })
      continue
    }
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } })
    if (prompt === "hang") continue
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FOREIGN" } }, "foreign")
    text(`ACP_REPLY_${turn}: `)
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read fixture",
      kind: "read",
      status: "in_progress",
    })
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "fixture contents" } }],
    })
    text(prompt.includes("unicode") ? "\u4f60\u597d\u2028\u4e16\u754c" : "complete")
    reply(id, { stopReason: prompt === "limit" ? "max_tokens" : "end_turn" })
  }
}
