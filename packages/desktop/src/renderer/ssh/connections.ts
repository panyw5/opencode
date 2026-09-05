import type { SshServersState } from "@opencode-ai/app/ssh/types"
import { type ServerConnection } from "@opencode-ai/app"

export function readySshConnections(state?: SshServersState): ServerConnection.Ssh[] {
  return (state?.servers ?? []).flatMap((item) => {
    if (item.runtime.kind !== "ready") return []
    return [
      {
        displayName: item.config.target,
        type: "ssh" as const,
        host: item.config.target,
        http: {
          url: item.runtime.url,
          username: item.runtime.username ?? undefined,
          password: item.runtime.password ?? undefined,
        },
      },
    ]
  })
}
