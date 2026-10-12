import { DEFAULT_GPT_PRO_CONFIG, type GptProConfig, type GptProJob } from "@opencode-ai/util/gpt-pro"

type Store = {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

export function createGptProPersistence(store: Store, log: (message: string) => void) {
  const started = performance.now()
  // electron-store parses the entire history on get(), including completed results.
  // Configuration changes go through setConfig; notification polls must stay in memory.
  let config = { ...((store.get("config") as GptProConfig | undefined) ?? DEFAULT_GPT_PRO_CONFIG) }
  log(`config cache initialized enabled=${config.enabled} durationMs=${(performance.now() - started).toFixed(2)}`)
  return {
    load() {
      const started = performance.now()
      const value = store.get("jobs")
      const jobs = Array.isArray(value)
        ? (value.filter(
            (job) =>
              job && typeof job.id === "string" && typeof job.owner === "string" && typeof job.prompt === "string",
          ) as GptProJob[])
        : []
      log(`history loaded jobs=${jobs.length} durationMs=${(performance.now() - started).toFixed(2)}`)
      return jobs
    },
    save(jobs: GptProJob[]) {
      const started = performance.now()
      store.set("jobs", jobs)
      const elapsed = performance.now() - started
      if (elapsed >= 16) log(`history save slow jobs=${jobs.length} durationMs=${elapsed.toFixed(2)}`)
    },
    config(): GptProConfig {
      return { ...config }
    },
    setConfig(next: GptProConfig) {
      const copy = { ...next }
      // Publish only after the durable write succeeds, so failed settings writes don't take effect.
      store.set("config", copy)
      config = copy
      log(`config cache updated enabled=${config.enabled}`)
    },
  }
}
