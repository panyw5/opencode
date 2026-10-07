export const BROWSER_BRIDGE_TICKET_QUERY = "ticket"
export const BROWSER_BRIDGE_TOKEN_HEADER = "x-opencode-ticket"
export const BROWSER_BRIDGE_TOKEN_HEADER_VALUE = "1"

const BROWSER_BRIDGE_PATH = /^\/browser\/bridge$/

// Auth middleware skips Basic Auth when this matches; the browser bridge
// connect handler is then responsible for validating the ticket.
export function isBrowserBridgePath(pathname: string) {
  return BROWSER_BRIDGE_PATH.test(pathname)
}

export function hasBrowserBridgeTicketURL(url: URL) {
  return isBrowserBridgePath(url.pathname) && !!url.searchParams.get(BROWSER_BRIDGE_TICKET_QUERY)
}
