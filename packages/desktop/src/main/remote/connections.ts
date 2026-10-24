import type { ServerResponse } from "node:http"

type ActiveConnection = { response: ServerResponse; cancel: () => void }

export class RemoteConnections {
  private readonly byDevice = new Map<string, Set<ActiveConnection>>()

  track(deviceId: string, response: ServerResponse, cancel: () => void = () => {}): () => void {
    let connections = this.byDevice.get(deviceId)
    if (!connections) this.byDevice.set(deviceId, (connections = new Set()))
    const connection = { response, cancel }
    connections.add(connection)
    const remove = () => {
      if (!connections?.delete(connection)) return
      cancel()
      if (connections.size === 0) this.byDevice.delete(deviceId)
    }
    response.once("close", remove)
    response.once("finish", remove)
    return remove
  }

  closeDevice(deviceId: string): void {
    const connections = this.byDevice.get(deviceId)
    this.byDevice.delete(deviceId)
    for (const { response, cancel } of connections ?? []) {
      cancel()
      if (!response.destroyed && !response.writableEnded) response.destroy()
    }
  }

  closeAll(): void {
    for (const deviceId of this.byDevice.keys()) this.closeDevice(deviceId)
  }
}
