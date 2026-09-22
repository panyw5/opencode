import type { UserMessage } from "@opencode-ai/sdk/v2"

type Local = {
  session: {
    reset(): void
    restore(msg: { sessionID: string; agent: string; model: UserMessage["model"]; variant?: string }): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, msg: UserMessage) => {
  local.session.restore({
    sessionID: msg.sessionID,
    agent: msg.agent,
    model: msg.model,
    variant: msg.model.variant,
  })
}
