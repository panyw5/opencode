import type { GptProLoginStatus } from "@opencode-ai/util/gpt-pro"

type LoginConnection = {
  start(): Promise<string>
  status(): GptProLoginStatus
  cancel(): GptProLoginStatus
}

// Opening instructions does not mutate shared cookies and must not require idle consultations.
export async function launchGptProLogin(
  login: LoginConnection,
  openExternal: (url: string) => Promise<void>,
  log: (message: string) => void,
) {
  log("login-launch requested action=open-connection-page cookiesChanged=false")
  let url: string
  try {
    url = await login.start()
  } catch {
    log("login-launch local-server outcome=failed; connection URL and token omitted")
    throw new Error("login_connection_failed: The local connection page could not be started. Try opening it again.")
  }
  log("login-launch local-server outcome=ready; connection URL and token omitted")
  try {
    await openExternal(url)
  } catch {
    login.cancel()
    log("login-launch default-browser outcome=failed; connection URL and token omitted")
    throw new Error("browser_open_failed: Could not open the default browser. Check your default browser and try again.")
  }
  log(`login-launch default-browser outcome=request-accepted phase=${login.status().phase}; cookiesChanged=false`)
  return login.status()
}
