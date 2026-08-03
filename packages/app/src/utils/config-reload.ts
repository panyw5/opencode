type ConfigRefreshInput = {
  refreshConfig: () => Promise<unknown>
  refresh?: () => void
  source: string
}

/** Make a direct config-file write visible without restarting the backend. */
export async function refreshAfterConfigWrite(input: ConfigRefreshInput) {
  console.info("[config] runtime config refresh requested", { source: input.source })
  await input.refreshConfig()
  console.info("[config] runtime config refresh completed", { source: input.source })

  input.refresh?.()
  console.info("[config] local config data refresh completed", { source: input.source })
}
