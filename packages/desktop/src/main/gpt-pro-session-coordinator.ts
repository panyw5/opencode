import { GPT_PRO_PARTITION, isGptProLoginUrl, isGptProOrigin, type GptProSessionState } from "@opencode-ai/util/gpt-pro"
import type { BrowserController, ViewState } from "./browser"
import type { BrowserCdp } from "./browser-cdp"
import { readGptProAuthentication } from "./gpt-pro-authentication"
import { CHATGPT_AUTH_METADATA_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"

type Browser = Pick<BrowserController, "getState"> & {
  cdp(pageID: string): Pick<BrowserCdp, "evaluate"> | undefined
  onViewState?: BrowserController["onViewState"]
  onViewClosed?: BrowserController["onViewClosed"]
}
type Authentication = GptProSessionState["authentication"]
const pageID = (view: ViewState) => view.pageID ?? view.partition
const stamp = (view: ViewState) => `${pageID(view)}:${view.epoch}:${view.documentEpoch ?? 0}:${view.url}`

/** Owns all application authentication for one Cookie jar. Snapshot reads never perform work. */
export class GptProSessionCoordinator {
  private state: GptProSessionState
  private pending?: { page: string; task: Promise<Authentication> }
  private importing = false
  private failures = 0
  private listeners = new Set<() => void>()
  private cleanup: Array<() => void> = []
  constructor(
    private browser: Browser,
    readonly profileID = GPT_PRO_PARTITION,
    private log: (message: string) => void = () => {},
    private now = Date.now,
  ) {
    this.state = {
      profileID,
      generation: 0,
      revision: 0,
      authentication: { phase: "unverified", checkedAt: 0 },
      page: { phase: "not_open" },
      import: { phase: "idle" },
    }
    if (browser.onViewState)
      this.cleanup.push(
        browser.onViewState((view) => {
          if ((view.profileID ?? view.partition) === this.profileID) this.pagesChanged()
        }),
      )
    if (browser.onViewClosed)
      this.cleanup.push(
        browser.onViewClosed((_id, _epoch, profile) => {
          if (profile === this.profileID) this.pagesChanged(true)
        }),
      )
    this.pagesChanged()
  }
  snapshot(): GptProSessionState {
    return structuredClone(this.state)
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  credentialsChanged() {
    if (this.importing) return
    this.state.generation++
    this.state.authentication = { phase: "unverified", checkedAt: this.now() }
    this.failures = 0
    this.log(
      `session credential generation changed profile=${this.profileID}; no automatic authentication or navigation`,
    )
    this.publish()
  }
  assertAuthentication(evidence: GptProSessionState["authentication"]) {
    const source = evidence.source
    const current = source && this.views().find((view) => pageID(view) === source.pageID)
    const auth = this.state.authentication
    if (
      evidence.phase !== "authenticated" ||
      !evidence.accountID ||
      auth.phase !== "authenticated" ||
      auth.accountID !== evidence.accountID ||
      !source ||
      source.generation !== this.state.generation ||
      !current ||
      current.loading ||
      current.authRedirectLoop ||
      stamp(current) !== `${source.pageID}:${source.epoch}:${source.documentEpoch}:${source.url}`
    )
      throw new GptProOperationError(
        "page_changed",
        "Verified login evidence changed before profile promotion. No execution authority was migrated.",
      )
  }
  private publish() {
    this.state.revision++
    this.log(
      `session state profile=${this.profileID} generation=${this.state.generation} revision=${this.state.revision} auth=${this.state.authentication.phase} page=${this.state.page.phase} import=${this.state.import.phase}; credentials omitted`,
    )
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        this.log("session subscriber failed")
      }
    }
  }
  private views() {
    return this.browser.getState().filter((view) => (view.profileID ?? view.partition) === this.profileID)
  }
  private pagesChanged(closed = false) {
    const views = this.views()
    const phase = !views.length
      ? closed
        ? "closed"
        : "not_open"
      : views.some((view) => view.authRedirectLoop)
        ? "navigation_error"
        : views.some((view) => !view.loading)
          ? "interactive"
          : "loading"
    const selected = views.find((view) => isGptProOrigin(view.url) && !isGptProLoginUrl(view.url)) ?? views[0]
    const location = selected
      ? isGptProLoginUrl(selected.url)
        ? "login"
        : isGptProOrigin(selected.url)
          ? "chatgpt"
          : "other"
      : undefined
    const source = this.state.authentication.source
    const valid =
      !source ||
      views.some((view) => stamp(view) === `${source.pageID}:${source.epoch}:${source.documentEpoch}:${source.url}`)
    if (phase === this.state.page.phase && location === this.state.page.location && valid) return
    this.state.page = { phase, location }
    if (!valid) this.state.authentication = { phase: "unverified", checkedAt: this.now() }
    this.publish()
  }
  async verify(requestedPageID?: string): Promise<Authentication> {
    if (this.importing) return { phase: "unverified", checkedAt: this.now() }
    this.pagesChanged()
    const previous = this.state.authentication
    // Explicit reconnect/import or document change is required after terminal login failure.
    if (["invalid", "verification"].includes(previous.phase)) return structuredClone(previous)
    if (previous.retryAt && previous.retryAt > this.now()) return structuredClone(previous)
    const views = this.views()
    const view = requestedPageID
      ? views.find((view) => pageID(view) === requestedPageID)
      : views
          .filter(
            (view) =>
              !view.loading && !view.authRedirectLoop && isGptProOrigin(view.url) && !isGptProLoginUrl(view.url),
          )
          .sort((a, b) => pageID(a).localeCompare(pageID(b)))[0]
    if (!view || view.loading || view.authRedirectLoop || !isGptProOrigin(view.url) || isGptProLoginUrl(view.url)) {
      // A login URL or redirect loop is page evidence, not proof of an expired Cookie.
      return { phase: "unverified", checkedAt: this.now() }
    }
    const key = stamp(view)
    if (this.pending) {
      this.log(`session authentication joined profile=${this.profileID} sameDocument=${this.pending.page === key}`)
      if (this.pending.page === key) return this.pending.task
      await this.pending.task
      return this.verify(requestedPageID)
    }
    const generation = this.state.generation
    const captured = { ...view }
    const task = Promise.resolve().then(() => this.inspect(captured, generation))
    this.pending = { page: key, task }
    try {
      return await task
    } finally {
      if (this.pending?.task === task) this.pending = undefined
    }
  }
  private async inspect(view: ViewState, generation: number, importVerification = false): Promise<Authentication> {
    // A queued check may not have started when reconnect invalidates its generation.
    if (generation !== this.state.generation || (this.importing && !importVerification))
      return { phase: "unverified", checkedAt: this.now() }
    const source = {
      pageID: pageID(view),
      epoch: view.epoch,
      documentEpoch: view.documentEpoch ?? 0,
      url: view.url,
      generation,
    }
    const discard = (): Authentication => {
      const result: Authentication = { phase: "unverified", checkedAt: this.now() }
      if (this.state.authentication.source === source) {
        this.state.authentication = result
        this.publish()
      }
      return result
    }
    this.state.authentication = { phase: "verifying", checkedAt: this.now(), source }
    this.publish()
    const start = performance.now()
    let model: string | undefined
    let result: Authentication = { phase: "transient", checkedAt: this.now(), source }
    try {
      const cdp = this.browser.cdp(pageID(view))
      if (!cdp) throw new Error("Page closed")
      const metadata = await cdp.evaluate<{ url: string; verification?: boolean; model?: string }>(
        CHATGPT_AUTH_METADATA_EXPRESSION,
      )
      model = typeof metadata.model === "string" ? metadata.model.slice(0, 200) : undefined
      if (metadata.verification) result = { phase: "verification", checkedAt: this.now(), source }
      else if (!isGptProOrigin(metadata.url) || isGptProLoginUrl(metadata.url))
        result = { phase: "unverified", checkedAt: this.now(), source }
      else {
        const current = this.views().find((current) => pageID(current) === pageID(view))
        if (
          !current ||
          current.loading ||
          stamp(current) !== stamp(view) ||
          generation !== this.state.generation ||
          (this.importing && !importVerification)
        ) {
          this.log(`session authentication metadata stale profile=${this.profileID}; no session request dispatched`)
          return discard()
        }
        const auth = await readGptProAuthentication(cdp, this.log)
        result = {
          phase:
            auth.phase === "authenticated" ? "authenticated" : auth.phase === "needs_login" ? "invalid" : "transient",
          checkedAt: this.now(),
          source,
          account: auth.account,
          accountID: auth.accountID,
          detail: auth.detail,
          ...(auth.phase === "unknown"
            ? {
                retryAt:
                  this.now() +
                  Math.max(auth.retryAfterMs ?? 0, Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6))),
              }
            : {}),
        }
      }
    } catch {
      result.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6))
    }
    const current = this.views().find((current) => pageID(current) === pageID(view))
    if (
      (this.importing && !importVerification) ||
      generation !== this.state.generation ||
      !current ||
      current.loading ||
      stamp(current) !== stamp(view)
    ) {
      this.log(
        `session authentication discarded profile=${this.profileID} staleDocumentOrGeneration=true durationMs=${(performance.now() - start).toFixed(2)}`,
      )
      return discard()
    }
    if (result.phase === "authenticated") {
      this.failures = 0
      if (this.state.import.phase === "pending_verification") this.state.import = { phase: "verified" }
    }
    this.state.authentication = result
    this.state.page = { ...this.state.page, model }
    this.log(
      `session authentication completed profile=${this.profileID} phase=${result.phase} durationMs=${(performance.now() - start).toFixed(2)}; identity omitted`,
    )
    this.publish()
    return structuredClone(result)
  }
  async importCredentials(action: () => Promise<void>, verify = false) {
    if (this.importing) throw new Error("A login import is already in progress")
    this.importing = true
    this.state.generation++
    this.state.import = { phase: "installing" }
    this.state.authentication = { phase: "unverified", checkedAt: this.now() }
    this.publish()
    try {
      await this.pending?.task
      await action()
      this.failures = 0
      this.state.import = { phase: "pending_verification" }
      if (verify) {
        this.publish()
        const view = this.views()
          .filter(
            (view) =>
              !view.loading && !view.authRedirectLoop && isGptProOrigin(view.url) && !isGptProLoginUrl(view.url),
          )
          .sort((a, b) => pageID(a).localeCompare(pageID(b)))[0]
        const auth = view ? await this.inspect({ ...view }, this.state.generation, true) : undefined
        if (auth?.phase !== "authenticated")
          throw new GptProOperationError(
            auth?.phase === "verification"
              ? "verification"
              : auth?.phase === "invalid"
                ? "login_expired"
                : "login_import_pending",
            "Credentials were installed, but ChatGPT authentication was not verified. No question was dispatched; complete login or retry explicit verification.",
          )
      }
    } catch (error) {
      this.state.import = { phase: "failed" }
      throw error
    } finally {
      this.importing = false
      this.publish()
    }
  }
  dispose() {
    this.state.generation++
    this.cleanup.forEach((cleanup) => cleanup())
    this.listeners.clear()
  }
}

const coordinators = new WeakMap<Browser, Map<string, GptProSessionCoordinator>>()
export function getGptProSessionCoordinator(
  browser: Browser,
  profileID = GPT_PRO_PARTITION,
  log?: (message: string) => void,
) {
  let profiles = coordinators.get(browser)
  if (!profiles) coordinators.set(browser, (profiles = new Map()))
  let coordinator = profiles.get(profileID)
  if (!coordinator) profiles.set(profileID, (coordinator = new GptProSessionCoordinator(browser, profileID, log)))
  return coordinator
}

export function releaseGptProSessionCoordinator(browser: Browser, profileID: string) {
  const profiles = coordinators.get(browser)
  profiles?.get(profileID)?.dispose()
  profiles?.delete(profileID)
}
