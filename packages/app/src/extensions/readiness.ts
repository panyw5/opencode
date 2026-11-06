export type ExtensionReadinessScope<Client> = Readonly<{
  url: string
  client: Client
  disabled: boolean
  safeReady: boolean
}>

// First manifest settlement belongs to a connection, not to the provider's
// lifetime. Keep this independent of Solid so connection races are testable.
export function createExtensionReadiness<Client>(
  read: () => ExtensionReadinessScope<Client>,
  changed: () => void = () => {},
) {
  type State = {
    scope: ExtensionReadinessScope<Client>
    ready: boolean
    promise: Promise<void>
    resolve(): void
  }
  let current: State | undefined
  let disposed = false
  const capture = () => {
    const scope = read()
    if (
      current &&
      (disposed ||
        (current.scope.url === scope.url &&
          current.scope.client === scope.client &&
          current.scope.disabled === scope.disabled &&
          current.scope.safeReady === scope.safeReady))
    )
      return current.scope
    // Wake old waiters so they can follow the current scope; this does not
    // mark either scope ready or let an old request settle the new one.
    current?.resolve()
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    current = { scope, ready: false, promise, resolve }
    changed()
    return scope
  }
  const ready = () => {
    capture()
    return !disposed && current!.ready
  }
  return {
    capture,
    ready,
    isCurrent(scope: ExtensionReadinessScope<Client>) {
      return !disposed && capture() === scope
    },
    settle(scope: ExtensionReadinessScope<Client>) {
      if (disposed || capture() !== scope || !scope.safeReady || current!.ready) return
      current!.ready = true
      current!.resolve()
      changed()
    },
    async whenReady(): Promise<void> {
      while (!disposed) {
        const scope = capture()
        if (current!.ready) return
        await current!.promise
        if (!disposed && capture() === scope && current!.ready) return
      }
    },
    dispose() {
      disposed = true
      current?.resolve()
      changed()
    },
  }
}
