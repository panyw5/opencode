/** A settings write invalidates every earlier read, including reads still awaiting the IPC response. */
export function createGptProRefreshFence() {
  let revision = 0
  return {
    begin: () => ++revision,
    invalidate: () => {
      revision++
    },
    current: (request: number) => request === revision,
  }
}

/** A late snapshot response must not overwrite a newer subscription event. */
export function createGptProRuntimeFence() {
  let sourceID: string | undefined
  let sequence = -1
  return {
    accept(next: { sourceID?: string; sequence?: number }) {
      if (!next.sourceID || next.sequence === undefined) return true
      if (sourceID === next.sourceID && next.sequence < sequence) return false
      sourceID = next.sourceID
      sequence = next.sequence
      return true
    },
  }
}
