let state: { connected: boolean; url?: string } = { connected: false }
const listeners = new Set<() => void>()
export const gptProBridgeState = () => ({ ...state })
export function onGptProBridgeState(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function setGptProBridgeState(connected: boolean, url?: string) {
  state = { connected, url }
  for (const listener of listeners) listener()
}
