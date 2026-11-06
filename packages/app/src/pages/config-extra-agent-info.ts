import type { Accessor } from "solid-js"
import type { ExtraAgentId, GenericagentConfig, HermesConfig, OpenclawConfig, Platform } from "@/context/platform"
import { createConfigLocalLoader } from "./config-local-loader"

type ExtraAgentConfig = OpenclawConfig | HermesConfig | GenericagentConfig

/** Keep each agent's last result while its local configuration or status is refreshed. */
export function createExtraAgentInfoLoader(options: {
  selected: Accessor<ExtraAgentId | undefined>
  ready: Accessor<boolean>
  config: Accessor<ExtraAgentConfig | undefined>
  configError: Accessor<unknown>
  inspect: Platform["getExtraAgentInfo"]
}) {
  const make = (id: ExtraAgentId) => {
    const inspect = options.inspect
    if (!inspect) return undefined
    return createConfigLocalLoader(
      () =>
        options.selected() === id && options.ready() && options.configError() === undefined
          ? { config: options.config() }
          : false,
      async (request) => {
        // Electron IPC cannot clone Solid store proxies.
        const config = request.config ? { ...request.config } : undefined
        console.debug("[config-extra-agent-info] inspect started id=" + id)
        const info = await inspect(id, config)
        console.debug("[config-extra-agent-info] inspect completed id=" + id)
        return { info }
      },
      "extra-agent-info." + id,
    )
  }
  const loaders = { openclaw: make("openclaw"), hermes: make("hermes"), genericagent: make("genericagent") }
  const current = () => {
    const id = options.selected()
    return id ? loaders[id] : undefined
  }
  return {
    get latest() {
      return current()?.latest?.info
    },
    get loading() {
      const loader = current()
      return !!loader && options.configError() === undefined && (!options.ready() || loader.loading)
    },
    get error() {
      return options.configError() ?? current()?.error
    },
  }
}
