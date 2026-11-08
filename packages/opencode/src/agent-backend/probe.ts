import type { AcpConfig } from "./schema"
import { AcpAgentClient, AcpAuthenticationRequired } from "./acp-client"
import { AcpTranscript } from "./acp-transcript"
import { managedAgents, type AgentInstallManager } from "./install"
import type { ProbeResult } from "./install-schema"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "agent-backend.probe" })
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
    config: { ...input.config, command: lease ? (lease.command as [string, ...string[]]) : input.config.command },
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
