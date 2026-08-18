type ConfigRefreshInput = {
  refreshConfig: () => Promise<unknown>
  refresh?: () => void
  source: string
}

export const CONFIG_PAGE_REFRESH_EVENT = "opencode:config-page-refresh"

export function requestConfigPageRefresh() {
  console.info("[config] dispatching config page refresh")
  window.dispatchEvent(new Event(CONFIG_PAGE_REFRESH_EVENT))
}

/** Make a direct config-file write visible without restarting the backend. */
export async function refreshAfterConfigWrite(input: ConfigRefreshInput) {
  console.info("[config] runtime config refresh requested", { source: input.source })
  await input.refreshConfig()
  console.info("[config] runtime config refresh completed", { source: input.source })

  input.refresh?.()
  console.info("[config] local config data refresh completed", { source: input.source })
}
