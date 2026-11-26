import type { AcpConfig } from "./schema"
import { AcpAgentClient, AcpAuthenticationRequired, AcpSessionNotFound } from "./acp-client"
import { AcpTranscript } from "./acp-transcript"
import { applyAdapterLease, managedAgents, type AgentInstallManager } from "./install"
import type { ProbeResult } from "./install-schema"
import { channelOptions } from "./options"
import type { Advisor } from "@/session/external-schema"
import type { AgentSession, AgentSessionList, AgentSessionPreview, ChannelOptions } from "@/session/channel-schema"
import * as Log from "@opencode-ai/core/util/log"
import { realpathSync } from "node:fs"

const log = Log.create({ service: "agent-backend.probe" })

const AGENT_SESSIONS_PAGE_LIMIT = 5
const AGENT_SESSIONS_LIMIT = 200

const normalized = (dir: string) => {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** Read a channel's models and modes without a session: spawns the ACP agent, negotiates, then stops it. */
export async function probeChannelOptions(
  input: { advisor: Advisor; config: AcpConfig; cwd: string; signal: AbortSignal },
  manager: AgentInstallManager = managedAgents(),
): Promise<ChannelOptions> {
  const ref = input.config.managed
  if (ref && ref.advisor !== input.advisor) throw new Error("Managed adapter does not match the selected advisor")
  const lease = ref ? await manager.acquire(ref.advisor, ref.version) : undefined
  const client = new AcpAgentClient({
    config: applyAdapterLease(input.config, lease),
    cwd: input.cwd,
    onEvent: () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  })
  try {
    log.info(`options start advisor=${input.advisor} managed=${!!ref} cwd=${input.cwd}`)
    await client.start(input.signal, {})
    const options = channelOptions(client, input.advisor)
    log.info(
      `options ready advisor=${input.advisor} models=${options.models.length} modes=${options.modes.length} model=${options.model ?? "none"}`,
    )
    return options
  } finally {
    await client.stop()
    await lease?.release()
  }
}

/**
 * List the agent's existing sessions for a working directory via ACP session/list.
 * Spawns the agent, initializes only (no session is created), then stops it.
 */
export async function probeAgentSessions(
  input: { advisor: Advisor; config: AcpConfig; cwd: string; signal: AbortSignal },
  manager: AgentInstallManager = managedAgents(),
): Promise<AgentSessionList> {
  const ref = input.config.managed
  if (ref && ref.advisor !== input.advisor) throw new Error("Managed adapter does not match the selected advisor")
  const lease = ref ? await manager.acquire(ref.advisor, ref.version) : undefined
  const client = new AcpAgentClient({
    config: applyAdapterLease(input.config, lease),
    cwd: input.cwd,
    onEvent: () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  })
  try {
    log.info(`sessions start advisor=${input.advisor} managed=${!!ref} cwd=${input.cwd}`)
    await client.start(input.signal, { initializeOnly: true })
    const loadable = Boolean(client.capabilities?.loadSession)
    if (!client.canListSessions) {
      log.info(`sessions unsupported advisor=${input.advisor} loadable=${loadable}`)
      return { supported: false, loadable, sessions: [] }
    }
    const sessions: AgentSession[] = []
    const home = normalized(input.cwd)
    let cursor: string | null | undefined
    for (let page = 0; page < AGENT_SESSIONS_PAGE_LIMIT && sessions.length < AGENT_SESSIONS_LIMIT; page++) {
      const result = await client.listSessions(input.cwd, cursor)
      sessions.push(
        ...result.sessions
          .filter((session) => !session.cwd || normalized(session.cwd) === home)
          .map((session) => ({
            id: session.sessionId,
            ...(session.title ? { title: session.title } : {}),
            cwd: session.cwd,
            ...(session.updatedAt ? { updated: session.updatedAt } : {}),
          })),
      )
      cursor = result.nextCursor ?? null
      if (!cursor) break
    }
    log.info(`sessions ready advisor=${input.advisor} count=${sessions.length} loadable=${loadable}`)
    return { supported: true, loadable, sessions: sessions.slice(0, AGENT_SESSIONS_LIMIT) }
  } finally {
    await client.stop()
    await lease?.release()
  }
}

const AGENT_PREVIEW_MESSAGES = 6
const AGENT_PREVIEW_CHARS = 600

/**
 * Replay the head of an agent session via ACP session/load and return the first
 * transcript messages. Spawns the agent, loads the session, then stops it.
 */
export async function probeAgentSessionPreview(
  input: { advisor: Advisor; config: AcpConfig; cwd: string; sessionID: string; signal: AbortSignal },
  manager: AgentInstallManager = managedAgents(),
): Promise<AgentSessionPreview> {
  const ref = input.config.managed
  if (ref && ref.advisor !== input.advisor) throw new Error("Managed adapter does not match the selected advisor")
  const lease = ref ? await manager.acquire(ref.advisor, ref.version) : undefined
  const replay = new AcpTranscript({ captureUser: true })
  const client = new AcpAgentClient({
    config: applyAdapterLease(input.config, lease),
    cwd: input.cwd,
    onEvent: (event) => replay.apply(event),
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  })
  // session/load streams the whole history before resolving; stop as soon as
  // enough distinct messages for the preview have been replayed.
  const seen = new Set<string>()
  let resolveEnough: () => void = () => {}
  const enough = new Promise<void>((resolve) => (resolveEnough = resolve))
  replay.onTranscript = (item) => {
    if (!item.text || (item.kind !== "user" && item.kind !== "message")) return
    seen.add(item.id)
    if (seen.size >= AGENT_PREVIEW_MESSAGES) resolveEnough()
  }
  const started = Date.now()
  try {
    log.info(`preview start advisor=${input.advisor} agentSession=${input.sessionID} cwd=${input.cwd}`)
    const loading = client
      .start(input.signal, { resumeSessionID: input.sessionID, loadOnly: true })
      .then(() => "done" as const)
    loading.catch(() => {})
    const outcome = await Promise.race([loading, enough.then(() => "early" as const)])
    if (outcome === "early") {
      log.info(`preview early-stop advisor=${input.advisor} agentSession=${input.sessionID} ms=${Date.now() - started}`)
    } else {
      await loading
    }
    const messages = replay.transcript
      .filter((item) => item.text && (item.kind === "user" || item.kind === "message"))
      .slice(0, AGENT_PREVIEW_MESSAGES)
      .map((item) => ({ kind: item.kind, text: item.text!.slice(0, AGENT_PREVIEW_CHARS) }))
    log.info(
      `preview ready advisor=${input.advisor} agentSession=${input.sessionID} messages=${messages.length} ms=${Date.now() - started}`,
    )
    return { supported: true, messages }
  } catch (error) {
    if (error instanceof AcpSessionNotFound) {
      log.info(
        `preview unavailable advisor=${input.advisor} agentSession=${input.sessionID} reason=${error.message} ms=${Date.now() - started}`,
      )
      return { supported: true, messages: [], unavailable: error.message }
    }
    throw error
  } finally {
    await client.stop()
    await lease?.release()
  }
}

export async function probeAdapter(
  input: {
    advisor: string
    config: AcpConfig
    cwd: string
    signal: AbortSignal
    authMethod?: string
    message?: boolean
  },
  manager: AgentInstallManager = managedAgents(),
): Promise<ProbeResult> {
  const ref = input.config.managed
  if (ref && ref.advisor !== input.advisor) throw new Error("Managed adapter does not match the selected advisor")
  const lease = ref ? await manager.acquire(ref.advisor, ref.version) : undefined
  const live = new AcpTranscript()
  const client = new AcpAgentClient({
    config: applyAdapterLease(input.config, lease),
    cwd: input.cwd,
    onEvent: (event) => live.apply(event),
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  })
  const methods = () =>
    client.authMethods.map((method) => ({
      id: method.id,
      name: method.name,
      type: "type" in method ? method.type : ("agent" as const),
      environment: "vars" in method ? method.vars.map((item) => item.name) : [],
      ...(method.description ? { description: method.description } : {}),
    }))
  try {
    log.info(`start advisor=${input.advisor} managed=${!!ref} message=${!!input.message} login=${!!input.authMethod}`)
    await client.start(input.signal, { authMethod: input.authMethod })
    if (input.message) {
      live.beginTurn("Reply with OK only. Do not access files or run tools.")
      await client.prompt("Reply with OK only. Do not access files or run tools.", input.signal, 60000)
      if (!live.text.trim()) throw new Error("The adapter returned an empty test response")
    }
    log.info(`ready advisor=${input.advisor} session=${client.sessionID}`)
    return {
      status: "ready",
      message: "ACP handshake and session creation succeeded",
      authMethods: methods(),
      ...(input.message ? { response: live.text.slice(0, 4000) } : {}),
    }
  } catch (error) {
    log.warn(`failed advisor=${input.advisor} authRequired=${error instanceof AcpAuthenticationRequired}`)
    return {
      status: error instanceof AcpAuthenticationRequired ? "authentication_required" : "error",
      message:
        error instanceof AcpAuthenticationRequired
          ? error.message
          : "ACP connection failed: " + String(error).slice(0, 2000),
      authMethods: methods(),
    }
  } finally {
    await client.stop()
    await lease?.release()
  }
}
