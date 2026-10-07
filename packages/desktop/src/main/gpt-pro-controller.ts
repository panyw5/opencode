import { randomUUID } from "node:crypto"
import {
  GPT_PRO_URL,
  normalizeGptProConfig,
  gptProTerminal,
  type GptProCommand,
  type GptProConfig,
  type GptProJob,
  type GptProPageState,
  type GptProBrowserCommand,
  type GptProRecovery,
  GPT_PRO_PARTITION,
  isGptProOrigin,
} from "@opencode-ai/util/gpt-pro"
import { GptProPageError } from "./gpt-pro-page-error"
import { collectGptProNotification } from "./gpt-pro-notifications"

export type GptProDriverAPI = {
  open(url?: string, fresh?: boolean): Promise<void>
  ready(): Promise<GptProPageState>
  page(): Promise<GptProPageState>
  verify(): Promise<GptProPageState>
  fill(prompt: string): Promise<void>
  submit(beforeDispatch?: () => Promise<void>, uid?: string): Promise<void>
  element?(uid: string): Promise<{ composer: boolean; send: boolean }>
  recover?(): void
  stop(): Promise<void>
  show?(url?: string): Promise<void>
  focus?(): Promise<void>
}
type Persistence = {
  load(): GptProJob[]
  save(jobs: GptProJob[]): void
  config(): GptProConfig
  setConfig(config: GptProConfig): void
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class GptProController {
  private jobs: GptProJob[]
  private pumping = false
  private active?: string
  private disposed = false
  private controlling = new Set<string>()
  private stages = new Map<string, GptProRecovery["stage"]>()
  constructor(
    private readonly driver: GptProDriverAPI,
    private readonly persistence: Persistence,
    private readonly log: (message: string) => void,
    private readonly pollMs = 1000,
    private readonly stableMs = 3000,
  ) {
    this.jobs = persistence.load().map((job) =>
      job.recovery && ["paused", "interrupted"].includes(job.phase)
        ? { ...job, phase: "queued" as const }
        : gptProTerminal(job.phase)
          ? job
          : {
              ...job,
              phase: job.background && job.submitted && job.userID ? ("queued" as const) : ("interrupted" as const),
              error:
                job.background && job.submitted && job.userID
                  ? undefined
                  : "Application restarted. Resume the original page; do not resend automatically.",
            },
    )
    this.save()
    void this.pump()
  }
  config() {
    return normalizeGptProConfig(this.persistence.config())
  }
  busy() {
    return !!this.active || this.jobs.some((job) => job.phase === "queued")
  }
  setConfig(config: GptProConfig) {
    const next = normalizeGptProConfig(config)
    this.persistence.setConfig(next)
    return next
  }
  list() {
    return this.jobs.map(({ html, text, notifications, notificationText, ...job }) => ({
      ...job,
      prompt: job.prompt.slice(0, 160),
    }))
  }
  notifications(directory?: string) {
    for (const job of this.jobs) this.notify(job)
    return this.jobs
      .filter(
        (job) =>
          job.owner.includes("\n") &&
          (directory === undefined || job.owner.slice(0, job.owner.lastIndexOf("\n")) === directory),
      )
      .flatMap((job) => job.notifications ?? [])
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .slice(0, 50)
      .map((event) => ({ ...event }))
  }
  acknowledge(directory: string, ids: string[]) {
    const accepted = new Set(ids)
    for (const job of this.jobs) {
      if (job.owner.slice(0, job.owner.lastIndexOf("\n")) !== directory) continue
      job.notifications = job.notifications?.filter((event) => !accepted.has(event.id))
    }
    this.save()
    this.log(`background notifications acknowledged directory=${directory} count=${ids.length}`)
  }
  private notify(job: GptProJob) {
    const event = collectGptProNotification(job, Date.now(), this.config().progressIntervalSeconds! * 1000)
    if (!event) return
    this.save()
    this.log(
      `background notification queued id=${event.id} kind=${event.kind} revision=${event.revision} chars=${event.text.length}`,
    )
  }
  dispose() {
    this.disposed = true
    for (const job of this.jobs)
      if (!gptProTerminal(job.phase) || job.id === this.active)
        this.update(job, {
          phase: "interrupted",
          error: "Application stopped. Resume tracking; never resend automatically.",
        })
  }
  private save() {
    const retained = new Set(
      this.jobs
        .filter((job) => gptProTerminal(job.phase) && job.id !== this.active)
        .slice(-30)
        .map((job) => job.id),
    )
    this.jobs = this.jobs.filter(
      (job) =>
        !gptProTerminal(job.phase) || job.id === this.active || retained.has(job.id) || !!job.notifications?.length,
    )
    this.persistence.save(this.jobs)
  }
  private update(job: GptProJob, input: Partial<GptProJob>) {
    const previous = job.phase
    Object.assign(job, input, { updatedAt: Date.now() })
    this.save()
    if (previous !== job.phase) this.log(`consult id=${job.id} phase=${job.phase} revision=${job.revision}`)
    this.notify(job)
  }
  private get(id: string | undefined, owner?: string) {
    let job = this.jobs.find((job) => job.id === id)
    if (!job || (owner !== undefined && job.owner !== owner))
      throw new Error("Consultation not found in this OpenCode session")
    const seen = new Set<string>()
    while (job.successorID) {
      if (seen.has(job.id)) throw new Error("Invalid consultation chain")
      seen.add(job.id)
      const next = this.jobs.find((item) => item.id === job!.successorID)
      if (!next || next.owner !== job.owner) throw new Error("Invalid consultation chain")
      job = next
    }
    return job
  }
  async command(input: GptProCommand, owner?: string): Promise<GptProJob> {
    if (this.disposed) throw new Error("The consultation controller is shutting down")
    const action = input.action ?? "consult"
    if (
      !["consult", "status", "read", "open", "stop", "pause", "resume", "intervene", "background", "send"].includes(
        action,
      )
    )
      throw new Error("Unknown gpt-pro action")
    if (action === "consult" || action === "intervene") {
      if (!this.config().enabled) throw new Error("Enable gpt-pro in Settings > External Agents first.")
      if (!input.prompt?.trim() || input.prompt.length > 100000)
        throw new Error("A self-contained prompt of at most 100000 characters is required")
      if (this.jobs.filter((job) => !gptProTerminal(job.phase)).length >= 30)
        throw new Error("Too many queued consultations")
      const requestID = input.requestID ?? randomUUID()
      const parent = action === "intervene" ? this.get(input.id, owner) : undefined
      if (parent) await this.syncURL(parent)
      const jobOwner = parent?.owner ?? owner ?? "human"
      if (input.background && !jobOwner.includes("\n"))
        throw new Error("Background consultations require a parent OpenCode session")
      const duplicate = this.jobs.find((job) => job.requestID === requestID && job.owner === jobOwner)
      if (duplicate) return { ...this.get(duplicate.id, jobOwner) }
      if (parent) {
        if (this.active && this.active !== parent.id) throw new Error("Another consultation currently owns the browser")
        if (this.active === parent.id) await this.command({ action: "stop", id: parent.id }, owner)
      }
      const job: GptProJob = {
        id: `gpt_${randomUUID()}`,
        owner: jobOwner,
        requestID,
        ...(parent ? { parentID: parent.id } : {}),
        phase: "queued",
        prompt: input.prompt.trim(),
        url: parent?.url ?? GPT_PRO_URL,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        submitted: false,
        revision: 0,
        background: input.background ?? parent?.background ?? false,
      }
      this.jobs.push(job)
      this.save()
      this.log(`consult created id=${job.id} promptChars=${job.prompt.length}`)
      if (parent) this.update(parent, { successorID: job.id })
      void this.pump()
      return { ...job }
    }
    const job = this.get(input.id, owner)
    if (action === "send") {
      this.requireRecovery(job, owner)
      this.controlling.add(job.id)
      try {
        await this.send(job, input.uid)
      } finally {
        this.controlling.delete(job.id)
      }
      return { ...job }
    }
    if (action === "background") {
      if (!job.owner.includes("\n")) throw new Error("Background consultations require a parent OpenCode session")
      this.update(job, { background: true })
      this.log(`consult promoted to background id=${job.id}; no prompt resent`)
    }
    if (action === "status") {
      const { html, notifications, notificationText, ...snapshot } = job
      return { ...snapshot, text: job.text?.slice(0, 20000) }
    }
    if (action === "read") return { ...job }
    if (action === "open") {
      if (this.active && this.active !== job.id)
        throw new Error("Pause or stop the active consultation before opening another conversation")
      if (this.active === job.id && this.driver.show) await this.driver.show(job.url)
      else await this.driver.open(job.url)
      await this.driver.focus?.()
    }
    if (action === "pause") {
      if (this.active !== job.id) throw new Error("Only the active consultation can be paused")
      this.update(job, { phase: "paused" })
      if (this.driver.show) await this.driver.show(job.url)
      else await this.driver.open(job.url)
      await this.driver.focus?.()
    }
    if (action === "stop") {
      if (job.phase === "completed" || job.phase === "cancelled") return { ...job }
      if (this.controlling.has(job.id)) throw new Error("A control operation is already in progress")
      this.controlling.add(job.id)
      try {
        if (this.active === job.id) await this.driver.stop()
        await this.syncURL(job)
        this.update(job, {
          phase: "cancelled",
          error: undefined,
          recovery: undefined,
          notifications: job.notifications?.filter((event) => !event.recovery),
        })
      } finally {
        this.controlling.delete(job.id)
      }
    }
    if (action === "resume") {
      if (!job.submitted && this.active !== job.id && !job.recovery)
        throw new Error(
          "Submission is unconfirmed. Use a new explicit consultation rather than automatically resending.",
        )
      if (this.active && this.active !== job.id) throw new Error("Another consultation owns the browser")
      const recovered = !!job.recovery
      if (recovered) this.driver.recover?.()
      await this.syncURL(job)
      if (recovered) this.log(`consult agent recovery released id=${job.id}; no new consultation created`)
      if (this.active === job.id)
        this.update(job, { phase: "generating", error: undefined, recovery: undefined, resumeCurrentPage: recovered })
      else {
        this.update(job, { phase: "queued", error: undefined, recovery: undefined, resumeCurrentPage: recovered })
        void this.pump()
      }
    }
    return { ...job }
  }
  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (true) {
        const job = this.jobs.find((job) => job.phase === "queued")
        if (!job) return
        this.active = job.id
        try {
          await this.run(job)
        } catch (error) {
          if (job.phase !== "cancelled") {
            const reason = error instanceof Error ? error.message : "Browser consultation failed"
            this.log(
              `consult fixed flow handoff id=${job.id} stage=${this.stages.get(job.id) ?? "open"} attempted=${job.sendAttempted === true || job.submitted} error=${reason}`,
            )
            this.update(job, {
              phase: "paused",
              // Returning recovery control ends the foreground waiter. Keep
              // owned results deliverable even if the model resumes asynchronously.
              background: job.background || job.owner.includes("\n"),
              error: reason,
              notificationPhase: undefined,
              recovery: {
                stage: this.stages.get(job.id) ?? "open",
                reason,
                needsHuman: error instanceof GptProPageError && error.kind === "verification",
              },
            })
            while (!this.disposed && job.phase === "paused") await sleep(this.pollMs)
            if (job.phase === "generating") {
              this.update(job, { phase: "queued" })
              continue
            }
          }
        }
        this.active = undefined
      }
    } finally {
      this.pumping = false
    }
  }
  private async run(job: GptProJob) {
    if (job.recovery) {
      this.update(job, { phase: "paused" })
      if (!(await this.checkpoint(job))) return
    }
    const current = job.resumeCurrentPage === true
    this.update(job, { phase: "preparing", resumeCurrentPage: undefined })
    this.stage(job, "open")
    if (!current) await this.driver.open(job.url, !job.parentID && !job.submitted)
    if (!(await this.checkpoint(job))) return
    this.stage(job, "ready")
    await this.driver.ready()
    if (!(await this.checkpoint(job))) return
    this.stage(job, "model")
    let page =
      job.submitted && job.userID && job.model === "GPT-6 Pro" ? await this.driver.page() : await this.driver.verify()
    if (!(await this.checkpoint(job))) return
    if (!job.submitted) {
      const parent = job.parentID ? this.jobs.find((item) => item.id === job.parentID) : undefined
      if (parent?.userID) {
        const limit = Date.now() + 30000
        while (!page.users.some((user) => user.id === parent.userID)) {
          if (Date.now() >= limit) throw new Error("Previous Chat context did not load. No follow-up was sent.")
          if (!(await this.checkpoint(job))) return
          await sleep(this.pollMs)
          page = await this.driver.page()
        }
      }
      if (page.generating || (page.draft.trim() && (!current || page.draft.trim() !== job.prompt)))
        throw new Error("The browser is busy or has a manual draft. Nothing was overwritten.")
      if (!job.parentID && page.users.length) throw new Error("Expected a new empty Chat conversation")
      this.update(job, { userCount: page.users.length, model: page.model, phase: "sending" })
      this.stage(job, "compose")
      if (!current || page.draft.trim() !== job.prompt) await this.driver.fill(job.prompt)
      if (!(await this.checkpoint(job))) return
      this.stage(job, "submit")
      await this.driver.submit(async () => this.update(job, { submitted: true, sendAttempted: true }))
    }
    this.stage(job, "track")
    let deadline = Date.now() + this.config().timeoutMinutes * 60000
    const submittedAt = Date.now()
    let stableAt = Date.now()
    let html = ""
    while (true) {
      if (this.disposed || ["cancelled", "failed", "interrupted"].includes(job.phase)) return
      if (this.controlling.has(job.id) || job.phase === "paused") {
        await sleep(this.pollMs)
        continue
      }
      if (Date.now() >= deadline) {
        this.update(job, {
          phase: "paused",
          error: "Consultation timed out. The original page is preserved; stop or resume explicitly.",
        })
        if (!(await this.checkpoint(job))) return
        deadline = Date.now() + this.config().timeoutMinutes * 60000
      }
      page = await this.driver.page()
      this.capturePendingURL(job, page)
      if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
      if (job.userID && page.users.at(-1)?.id === job.userID && page.url !== job.url)
        this.update(job, { url: page.url })
      // Once acknowledged, model evidence belongs to this submitted turn.
      // A remounted composer selects the NEXT question's model, not this reply's.
      if (!page.targetModel && (!job.userID || job.model !== "GPT-6 Pro")) page = await this.driver.verify()
      if (this.controlling.has(job.id) || ["paused", "cancelled"].includes(job.phase)) continue
      const user = page.users.at(-1)
      const expectedCount = (job.userCount ?? 0) + 1
      if (
        page.users.length > expectedCount ||
        (page.users.length >= expectedCount && job.userID && user?.id !== job.userID) ||
        (page.users.length === expectedCount && user?.text.trim() !== job.prompt)
      ) {
        this.update(job, {
          phase: "paused",
          error: "The page was changed manually. Stop or intervene explicitly; no unrelated reply was returned.",
        })
        continue
      }
      if (page.draft.trim() && page.draft.trim() !== job.prompt) {
        this.update(job, { phase: "paused", error: "A manual draft was detected; automation paused." })
        continue
      }
      if (page.users.length !== expectedCount || !user) {
        if (Date.now() - submittedAt > 30000)
          throw new Error("Submission could not be confirmed. Do not automatically resend.")
        await sleep(this.pollMs)
        continue
      }
      if (!job.userID)
        this.update(job, { userID: user.id, phase: "generating", url: page.url, model: job.model ?? page.model })
      else if (job.phase === "preparing" || job.phase === "sending")
        this.update(job, { phase: "generating", error: undefined })
      const answer = page.answer
      if (answer?.userID === user.id) {
        if (answer.truncated) throw new Error("Reply exceeds HTML capture limit; incomplete output is not success.")
        if (html !== answer.html) {
          html = answer.html
          stableAt = Date.now()
          this.update(job, { text: answer.text, html, revision: job.revision + 1, url: page.url })
        }
        if (!answer.complete || page.generating) stableAt = Date.now()
        if (answer.complete && !page.generating && Date.now() - stableAt >= this.stableMs) {
          this.update(job, { phase: "completed", error: undefined })
          return
        }
      }
      this.notify(job)
      await sleep(this.pollMs)
    }
  }
  private async checkpoint(job: GptProJob) {
    while (!this.disposed && (job.phase === "paused" || this.controlling.has(job.id))) await sleep(this.pollMs)
    return !this.disposed && job.phase !== "cancelled"
  }
  private stage(job: GptProJob, stage: GptProRecovery["stage"]) {
    this.stages.set(job.id, stage)
    this.log(`consult stage id=${job.id} stage=${stage}`)
  }
  private requireRecovery(job: GptProJob, owner?: string) {
    if (owner !== undefined && job.owner !== owner) throw new Error("Consultation belongs to another session")
    if (this.active !== job.id || job.phase !== "paused" || !job.recovery)
      throw new Error("Browser interaction is available only for the active consultation's agent recovery handoff")
    if (this.controlling.has(job.id)) throw new Error("A browser control operation is already in progress")
  }
  private async requireReadable(job: GptProJob) {
    if (this.active === job.id) return
    if (!this.active && job.submitted && job.userID) {
      const page = await this.driver.page()
      if (page.url === job.url && page.users.at(-1)?.id === job.userID) return
    }
    throw new Error("The requested consultation does not own the current browser page")
  }
  private async send(job: GptProJob, uid?: string) {
    if (job.sendAttempted === true || job.submitted)
      throw new Error("A send was already attempted. Inspect and resume the original question; never resend.")
    const page = await this.driver.page()
    if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
    if (
      !page.targetModel ||
      page.generating ||
      page.draft.trim() !== job.prompt ||
      page.users.length !== (job.userCount ?? 0)
    )
      throw new Error("Managed send requires the exact original prompt, verified GPT-6 Pro, and unchanged conversation")
    if (uid && !(await this.driver.element?.(uid))?.send)
      throw new Error("The observed element is not a send control; no question dispatched")
    this.update(job, { model: page.model, userCount: page.users.length })
    this.log(`consult managed recovery send id=${job.id} uid=${uid ?? "website-send-control"}`)
    await this.driver.submit(async () => this.update(job, { submitted: true, sendAttempted: true }), uid)
    await this.syncURL(job)
  }
  async browserCommand(
    owner: string,
    id: string,
    name: GptProBrowserCommand,
    args: Record<string, unknown>,
    execute: (partition: string) => Promise<unknown>,
  ) {
    const job = this.get(id, owner)
    const readOnly = ["state", "snapshot", "screenshot"].includes(name)
    if (readOnly) await this.requireReadable(job)
    else {
      this.requireRecovery(job, owner)
      this.controlling.add(job.id)
    }
    this.log(`consult recovery browser id=${job.id} command=${name} owner=${JSON.stringify(owner)}`)
    try {
      if (!["state", "snapshot", "screenshot", "navigate", "click", "type", "scroll", "close"].includes(name))
        throw new Error("Unsupported consultation browser operation")
      if (name === "navigate") {
        const url = String(args.url ?? "")
        if (!isGptProOrigin(url) || (job.submitted && url !== job.url))
          throw new Error("Recovery navigation must preserve the original ChatGPT conversation")
        const page = await this.driver.page().catch(() => undefined)
        if (
          page &&
          ((page.draft.trim() && page.draft.trim() !== job.prompt) ||
            (page.generating && page.users.at(-1)?.id !== job.userID))
        )
          throw new Error("Recovery navigation must preserve unrelated drafts and generation")
      }
      if (name === "click" || name === "type") {
        const page = await this.driver.page()
        if (page.error?.kind === "verification")
          throw new Error("Human browser verification is required; agent clicks and typing are blocked")
        if (job.submitted && page.url !== job.url)
          throw new Error("The original submitted conversation must be restored before interacting")
        const uid = String(args.uid ?? "")
        const element = await this.driver.element?.(uid)
        if (!element) throw new Error("Browser element inspection is unavailable")
        if (name === "type" && args.submit === true)
          throw new Error("Use managed gpt_pro_consult action=send, not Enter, for consultation submission")
        if (name === "type" && element.composer) {
          if (
            job.sendAttempted === true ||
            job.submitted ||
            String(args.text ?? "").trim() !== job.prompt ||
            (page.draft.trim() && page.draft.trim() !== job.prompt)
          )
            throw new Error(
              "Composer recovery may restore only the original managed prompt and must preserve unrelated drafts",
            )
        }
        if (name === "click" && element.send) {
          await this.send(job, uid)
          return { state: undefined, managedSend: true }
        }
      }
      const result = await execute(GPT_PRO_PARTITION)
      await this.syncURL(job)
      return name === "state" && result && typeof result === "object"
        ? { ...result, consultationCreatedAt: job.createdAt }
        : result
    } finally {
      if (!readOnly) this.controlling.delete(job.id)
      this.log(`consult recovery browser settled id=${job.id} command=${name}`)
    }
  }
  private async syncURL(job: GptProJob) {
    try {
      const page = await this.driver.page()
      this.capturePendingURL(job, page)
      const user = page.users.at(-1)
      if (
        !job.userID &&
        job.submitted &&
        job.model === "GPT-6 Pro" &&
        page.users.length === (job.userCount ?? 0) + 1 &&
        user?.text.trim() === job.prompt
      ) {
        this.log(`consult recovering acknowledged turn id=${job.id} userID=${user.id}; no question resent`)
        this.update(job, { userID: user.id, url: page.url })
        return
      }
      if (job.userID && page.users.at(-1)?.id === job.userID && page.url !== job.url)
        this.update(job, { url: page.url })
    } catch {
      /* closed views must not cause a new submission */
    }
  }
  private capturePendingURL(job: GptProJob, page: GptProPageState) {
    if (
      job.submitted &&
      !job.userID &&
      !page.users.length &&
      isGptProOrigin(page.url) &&
      new URL(page.url).pathname.startsWith("/c/") &&
      page.url !== job.url
    ) {
      this.log(`consult pending conversation URL captured id=${job.id}; awaiting question acknowledgment`)
      this.update(job, { url: page.url })
    }
  }
}
