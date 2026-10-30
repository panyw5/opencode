import { isGptProOrigin } from "@opencode-ai/util/gpt-pro"

export const GPT_PRO_REDIRECT_LOOP_DETAIL =
  "ChatGPT repeatedly redirected between home and login. Automatic navigation was stopped. Reconnect ChatGPT using the browser login import; existing questions and attachments were preserved."

/** Bound only the observed home/login bounce, never ordinary conversation navigation. */
export class GptProNavigationGuard {
  private paths: Array<{ path: string; at: number }> = []
  private requests: number[] = []
  blocked = false

  reset() {
    this.paths = []
    this.requests = []
    this.blocked = false
  }

  request(url: string, now = Date.now()) {
    if (!this.allow(url, now)) return false
    const path = isGptProOrigin(url) ? new URL(url).pathname : undefined
    if (path !== "/" && path !== "/auth/login") return true
    // A failed login can also replace itself without visiting home. Count
    // document requests separately from duplicate committed/SPA events.
    this.requests = this.requests.filter((at) => now - at < 15_000)
    this.requests.push(now)
    if (this.requests.length < 5) return true
    this.blocked = true
    return false
  }

  allow(url: string, now = Date.now()) {
    const path = isGptProOrigin(url) ? new URL(url).pathname : undefined
    if (path !== "/" && path !== "/auth/login") {
      this.reset()
      return true
    }
    if (this.blocked) return false
    this.paths = this.paths.filter((item) => now - item.at < 15_000)
    if (this.paths.at(-1)?.path !== path) this.paths.push({ path, at: now })
    if (this.paths.length < 5) return true
    this.blocked = true
    return false
  }
}
