import type { UserMessage } from "@opencode-ai/sdk/v2"

type RestoreQueueInput<T> = {
  ready: () => boolean
  wait?: Promise<unknown>
  restore: (msg: T) => void
}

export function createSessionModelRestoreQueue<T>(input: RestoreQueueInput<T>) {
  let pending: T | undefined
  let waiting = false

  const flush = () => {
    waiting = false
    const next = pending
    pending = undefined
    if (!next || !input.ready()) return
    input.restore(next)
  }

  return (msg: T) => {
    if (input.ready()) {
      input.restore(msg)
      return
    }

    pending = msg
    if (waiting) return
    waiting = true

    if (input.wait) {
      void input.wait.then(flush, flush)
      return
    }

    queueMicrotask(flush)
  }
}

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
