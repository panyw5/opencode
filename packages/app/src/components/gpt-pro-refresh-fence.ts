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
