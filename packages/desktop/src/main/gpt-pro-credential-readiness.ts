/** Owns the retryable initialization promise, not authentication or credential material. */
export function createGptProCredentialReadiness(deps: {
  initialize(): Promise<void>
  persist(): Promise<void>
  initialized(): boolean
  initializationFailed(cause: unknown): never
}) {
  let ready = deps.initialize().catch(deps.initializationFailed)
  let recovery: Promise<void> | undefined
  void ready.catch(() => {})
  return {
    ready: () => ready,
    recover() {
      if (recovery) return recovery
      recovery = (deps.initialized() ? deps.persist() : deps.initialize().catch(deps.initializationFailed)).finally(
        () => {
          recovery = undefined
        },
      )
      ready = recovery
      void ready.catch(() => {})
      return recovery
    },
  }
}
