import type { GptProRuntimeStatus, GptProSessionState } from "@opencode-ai/util/gpt-pro"

/** All dependencies are cached reads. No preparation, inspection, persistence or page creation here. */
export function gptProRuntimeSnapshot(input: {
  session: GptProSessionState
  config: GptProRuntimeStatus["config"]
  login: GptProRuntimeStatus["login"]
  credentials: GptProRuntimeStatus["credentials"]
  bridge: GptProRuntimeStatus["bridge"]
  managed: Pick<GptProRuntimeStatus, "importBlocked" | "blockers">
}): GptProRuntimeStatus {
  return {
    session: input.session,
    config: input.config,
    login: input.login,
    credentials: input.credentials,
    bridge: input.bridge,
    ...input.managed,
    // History has its own shared, versioned feed. Never duplicate it in runtime events.
  }
}
