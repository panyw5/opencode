let state: { connected: boolean; url?: string } = { connected: false }
export const gptProBridgeState = () => ({ ...state })
export function setGptProBridgeState(connected: boolean, url?: string) {
  state = { connected, url }
}
