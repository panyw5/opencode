export function imSelectedProject(saved: string, current: string, directories: string[]) {
  if (directories.includes(saved)) return saved
  return directories.includes(current) ? current : ""
}

export async function imLoadBatch<C, W, S>(requests: {
  channels: () => Promise<C>
  subscriptions: () => Promise<W>
  sessions: () => Promise<S>
}) {
  return Promise.all([requests.channels(), requests.subscriptions(), requests.sessions()] as const)
}

export function imPreferenceInitPending(init: unknown): init is Promise<unknown> {
  return init instanceof Promise
}
