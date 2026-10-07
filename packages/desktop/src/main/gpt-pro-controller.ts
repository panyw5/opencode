import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  GPT_PRO_URL,
  normalizeGptProConfig,
  gptProTerminal,
  type GptProCommand,
  type GptProAttachment,
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
  uploadAttachments?(
    files: Array<{ path: string; name: string; mime?: string; sha256?: string }>,
    mayDispatch: boolean,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<void>
  submit(beforeDispatch?: () => Promise<void>, uid?: string): Promise<void>
  element?(uid: string): Promise<{ composer: boolean; send: boolean; retry?: boolean }>
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
  stagingRoot?(): string
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const ATTACHMENT_COUNT_LIMIT = 10
const ATTACHMENT_FILE_LIMIT = 20 * 1024 * 1024
const ATTACHMENT_TOTAL_LIMIT = 50 * 1024 * 1024
const ATTACHMENT_NAME_LIMIT = 255
const attachmentTypes = new Map([
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".txt", "text/plain"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
])
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const attachmentIdentity = (attachment: {
  name: string
  uploadName?: string
  kind?: "document" | "image"
  mime?: string
  sha256?: string
}) =>
  attachment.kind === "image" || attachment.mime?.startsWith("image/")
    ? `image:${attachment.sha256 ?? "unknown"}`
    : `document:${attachment.uploadName ?? attachment.name}`
const truncateUtf8 = (value: string, maxBytes: number) => {
  let result = ""
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break
    result += character
  }
  return result
}
const uploadFileName = (jobID: string, index: number, originalName: string) => {
  const extension = path.extname(originalName)
  const stem = extension ? originalName.slice(0, -extension.length) : originalName
  const prefix = `${jobID.slice(4)}-${index + 1}-`
  const maxStemBytes = ATTACHMENT_NAME_LIMIT - Buffer.byteLength(prefix + extension, "utf8")
  return `${prefix}${truncateUtf8(stem, maxStemBytes)}${extension}`
}
function validateAttachmentBytes(extension: string, bytes: Uint8Array) {
  const ascii = (start: number, length: number) => Buffer.from(bytes.subarray(start, start + length)).toString("ascii")
  if (extension === ".pdf" && ascii(0, 5) !== "%PDF-") throw new Error("Attachment content does not match PDF type")
  if (extension === ".png" && Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("Attachment content does not match PNG type")
  if ([".jpg", ".jpeg"].includes(extension) && (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff))
    throw new Error("Attachment content does not match JPEG type")
  if (extension === ".webp" && (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP"))
    throw new Error("Attachment content does not match WebP type")
  if ([".md", ".markdown", ".txt"].includes(extension)) {
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new Error("Text attachment is not valid UTF-8")
    }
    if (text.includes("\0")) throw new Error("Text attachments cannot contain binary data")
  }
}

export class GptProController {
  private jobs: GptProJob[]
  private pumping = false
  private active?: string
  private disposed = false
  private controlling = new Set<string>()
  private creating = new Map<string, Promise<GptProJob>>()
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
    return this.jobs.map((job) => {
      const { html: _html, text: _text, notifications: _notifications, notificationText: _notificationText, ...visible } = job
      return this.publicJob({ ...visible, prompt: visible.prompt.slice(0, 160) })
    })
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
    const previous = this.jobs
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
    const remaining = new Set(this.jobs.map((job) => job.id))
    for (const job of previous) {
      if (remaining.has(job.id) || !job.stagedAttachments?.length) continue
      const root = this.persistence.stagingRoot?.()
      if (!/^gpt_[a-f0-9-]+$/i.test(job.id)) continue
      const owned = root && path.join(root, job.id)
      if (
        owned &&
        job.stagedAttachments.every((file) => {
          const relative = path.relative(owned, file.path)
          return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        })
      ) {
        void rm(owned, { recursive: true, force: true }).then(
          () => this.log(`consult attachment staging cleaned job=${job.id}`),
          () => this.log(`consult attachment staging cleanup failed job=${job.id}`),
        )
      }
    }
    this.persistence.save(this.jobs)
  }
  private update(job: GptProJob, input: Partial<GptProJob>) {
    const previous = job.phase
    Object.assign(job, input, { updatedAt: Date.now() })
    this.save()
    if (previous !== job.phase) this.log(`consult id=${job.id} phase=${job.phase} revision=${job.revision}`)
    this.notify(job)
  }
  private publicJob(job: GptProJob): GptProJob {
    const attachments = job.attachments?.map(({ path: _path, ...attachment }) => ({ ...attachment }))
    const { stagedAttachments: _stagedAttachments, ...result } = job
    return { ...result, ...(attachments ? { attachments } : {}) }
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
  private async stageAttachments(jobID: string, attachments: GptProAttachment[]) {
    if (!attachments.length) return []
    if (attachments.length > ATTACHMENT_COUNT_LIMIT) throw new Error("At most 10 files can be attached")
    if (new Set(attachments.map((item) => item.id)).size !== attachments.length)
      throw new Error("Attachment identifiers must be unique")
    const total = attachments.reduce((sum, item) => sum + item.size, 0)
    if (total > ATTACHMENT_TOTAL_LIMIT) throw new Error("Attachments exceed the local 50 MiB total limit")
    const base = this.persistence.stagingRoot?.()
    if (!base) throw new Error("Owned attachment staging is unavailable")
    const root = path.join(base, jobID)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const staged: NonNullable<GptProJob["stagedAttachments"]> = []
    try {
      for (let index = 0; index < attachments.length; index++) {
        const attachment = attachments[index]
        this.log(`consult attachment validation job=${jobID} index=${index + 1} count=${attachments.length}`)
        const extension = path.extname(attachment.name).toLowerCase()
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(attachment.id)) throw new Error("Attachment identifier is invalid")
        if (
          !attachment.name ||
          attachment.name.includes("\\") ||
          attachment.name.includes("/") ||
          path.basename(attachment.name) !== attachment.name
        )
          throw new Error("Attachment names must be plain filenames")
        if (attachmentTypes.get(extension) !== attachment.mime)
          throw new Error("Attachment type is not supported")
        if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > ATTACHMENT_FILE_LIMIT)
          throw new Error("Each attachment must be at most 20 MiB")
        if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) throw new Error("Attachment digest is invalid")
        const info = await lstat(attachment.path)
        if (!path.isAbsolute(attachment.path) || !info.isFile() || info.isSymbolicLink() || info.size !== attachment.size)
          throw new Error("Attachment source changed or is not a regular file")
        const handle = await open(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.size !== attachment.size) throw new Error("Attachment source changed during validation")
          const chunks: Buffer[] = []
          let size = 0
          const chunk = Buffer.alloc(64 * 1024)
          while (true) {
            const result = await handle.read(chunk, 0, Math.min(chunk.byteLength, attachment.size + 1 - size), null)
            if (!result.bytesRead) break
            size += result.bytesRead
            if (size > attachment.size || size > ATTACHMENT_FILE_LIMIT)
              throw new Error("Attachment source grew beyond its authorized size")
            chunks.push(Buffer.from(chunk.subarray(0, result.bytesRead)))
          }
          const after = await handle.stat()
          if (after.size !== attachment.size || size !== attachment.size)
            throw new Error("Attachment source changed during validation")
          bytes = Buffer.concat(chunks, size)
        } finally {
          await handle.close()
        }
        const sourceDigest = digest(bytes)
        if (sourceDigest !== attachment.sha256.toLowerCase())
          throw new Error("Attachment source digest does not match authorized metadata")
        validateAttachmentBytes(extension, bytes)
        const directory = path.join(root, attachment.id)
        await mkdir(directory, { mode: 0o700 })
        const uploadName = uploadFileName(jobID, index, attachment.name)
        if (Buffer.byteLength(uploadName, "utf8") > ATTACHMENT_NAME_LIMIT)
          throw new Error("Generated upload filename exceeds the local filename limit")
        const target = path.join(directory, uploadName)
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 })
        const stagedDigest = digest(await readFile(target))
        if (stagedDigest !== sourceDigest) throw new Error("Staged attachment integrity check failed")
        staged.push({ id: attachment.id, path: target, sha256: stagedDigest, uploadName })
        this.log(`consult attachment staged job=${jobID} index=${index + 1} bytes=${bytes.byteLength} digestVerified=true`)
      }
      return staged
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }
  private async createConsultation(
    input: GptProCommand,
    parent: GptProJob | undefined,
    jobOwner: string,
    requestID: string,
    owner?: string,
  ) {
    const jobID = `gpt_${randomUUID()}`
    const stagedAttachments = await this.stageAttachments(jobID, input.attachments ?? [])
    try {
      if (parent) {
        if (this.active && this.active !== parent.id) throw new Error("Another consultation currently owns the browser")
        if (this.active === parent.id) await this.command({ action: "stop", id: parent.id }, owner)
      }
      const job: GptProJob = {
        id: jobID,
        owner: jobOwner,
        requestID,
        ...(parent ? { parentID: parent.id } : {}),
        phase: "queued",
        prompt: input.prompt!.trim(),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((attachment, index) => ({
                ...attachment,
                uploadName: stagedAttachments[index].uploadName,
                status: "pending" as const,
              })),
              stagedAttachments,
            }
          : {}),
        url: parent?.url ?? GPT_PRO_URL,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        submitted: false,
        revision: 0,
        background: input.background ?? parent?.background ?? false,
      }
      this.jobs.push(job)
      this.save()
      this.log(`consult created id=${job.id} promptChars=${job.prompt.length} attachments=${job.attachments?.length ?? 0}`)
      if (parent) this.update(parent, { successorID: job.id })
      void this.pump()
      return job
    } catch (error) {
      if (stagedAttachments.length) {
        const root = this.persistence.stagingRoot?.()
        if (root) await rm(path.join(root, jobID), { recursive: true, force: true })
      }
      throw error
    }
  }
  private async ensureAttachments(job: GptProJob) {
    if (!job.attachments?.length) return
    const staged = job.stagedAttachments ?? []
    if (staged.length !== job.attachments.length || !this.driver.uploadAttachments)
      throw new Error("Owned attachment staging or browser upload support is unavailable")
    const root = this.persistence.stagingRoot?.()
    if (!root) throw new Error("Owned attachment staging is unavailable")
    const files: Array<{ path: string; name: string; mime: string; sha256: string }> = []
    for (const attachment of job.attachments) {
      const copy = staged.find((item) => item.id === attachment.id)
      if (
        !copy ||
        copy.uploadName !== attachment.uploadName ||
        path.basename(copy.path) !== attachment.uploadName
      )
        throw new Error("Staged attachment metadata is incomplete")
      const relative = path.relative(path.join(root, job.id), copy.path)
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Staged attachment path is outside its owned job directory")
      const info = await lstat(copy.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== attachment.size)
        throw new Error("Staged attachment changed before upload")
      const bytes = await readFile(copy.path)
      if (digest(bytes) !== copy.sha256 || copy.sha256 !== attachment.sha256.toLowerCase())
        throw new Error("Staged attachment digest changed before upload")
      this.log(`consult attachment pre-upload integrity job=${job.id} id=${attachment.id} bytes=${bytes.byteLength} verified=true`)
      files.push({ path: copy.path, name: attachment.uploadName, mime: attachment.mime, sha256: copy.sha256 })
    }
    const mayDispatch = job.attachments.every((attachment) => attachment.status === "pending")
    if (mayDispatch)
      this.update(job, { attachments: job.attachments.map((attachment) => ({ ...attachment, status: "uploading", error: undefined })) })
    try {
      await this.driver.uploadAttachments(files, mayDispatch, () => this.checkpoint(job))
      const page = await this.driver.page()
      if (!this.hasExactAttachmentEvidence(job, page))
        throw new Error("Attachment upload returned without exact ready-card evidence")
      this.update(job, { attachments: job.attachments.map((attachment) => ({ ...attachment, status: "ready", error: undefined })) })
      this.log(`consult attachments verified job=${job.id} count=${files.length}`)
    } catch (error) {
      if (job.phase === "cancelled" || this.disposed) throw error
      const failed = error instanceof Error && error.message.includes("reported an attachment upload error")
      this.update(job, {
        attachments: job.attachments.map((attachment) => ({
          ...attachment,
          status: failed ? "failed" : "unknown",
          error: failed ? "ChatGPT reported an upload error." : "Attachment upload state could not be confirmed.",
        })),
      })
      this.log(`consult attachment upload paused job=${job.id} count=${files.length} state=${failed ? "failed" : "unknown"}`)
      throw error
    }
  }
  private hasExactAttachmentEvidence(job: GptProJob, page: GptProPageState) {
    const expected = (job.attachments ?? []).map(attachmentIdentity).sort()
    const current = (page.attachments ?? []).map(attachmentIdentity).sort()
    return (
      expected.length === current.length &&
      expected.every((name, index) => name === current[index]) &&
      (page.attachments ?? []).every((attachment) => attachment.status === "ready")
    )
  }
  private hasExactUserAttachmentEvidence(job: GptProJob, user: GptProPageState["users"][number]) {
    const expected = (job.attachments ?? []).map(attachmentIdentity).sort()
    const current = (user.attachments ?? []).map(attachmentIdentity).sort()
    return (
      expected.length === current.length &&
      expected.every((name, index) => name === current[index]) &&
      (user.attachments ?? []).every((attachment) => attachment.status === "ready")
    )
  }
  private hasUnexpectedUserAttachments(job: GptProJob, user: GptProPageState["users"][number]) {
    const expected = new Map<string, number>()
    for (const attachment of job.attachments ?? []) {
      const key = attachmentIdentity(attachment)
      expected.set(key, (expected.get(key) ?? 0) + 1)
    }
    const current = user.attachments ?? []
    if (current.length > (job.attachments?.length ?? 0)) return true
    for (const attachment of current) {
      if (attachment.kind === "image" && !attachment.sha256) continue
      const key = attachmentIdentity(attachment)
      const remaining = expected.get(key) ?? 0
      if (!remaining) return true
      expected.set(key, remaining - 1)
    }
    return false
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
      const key = JSON.stringify([jobOwner, requestID])
      const pending = this.creating.get(key)
      if (pending) return this.publicJob(await pending)
      const duplicate = this.jobs.find((job) => job.requestID === requestID && job.owner === jobOwner)
      if (duplicate) return this.publicJob(this.get(duplicate.id, jobOwner))
      const task = this.createConsultation(input, parent, jobOwner, requestID, owner)
      this.creating.set(key, task)
      try {
        return this.publicJob(await task)
      } finally {
        this.creating.delete(key)
      }
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
      return this.publicJob(job)
    }
    if (action === "background") {
      if (!job.owner.includes("\n")) throw new Error("Background consultations require a parent OpenCode session")
      this.update(job, { background: true })
      this.log(`consult promoted to background id=${job.id}; no prompt resent`)
    }
    if (action === "status") {
      const { html, notifications, notificationText, ...snapshot } = this.publicJob(job)
      return { ...snapshot, text: job.text?.slice(0, 20000) }
    }
    if (action === "read") return this.publicJob(job)
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
      if (job.phase === "completed" || job.phase === "cancelled") return this.publicJob(job)
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
    return this.publicJob(job)
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
      if (
        page.generating ||
        (page.draft.trim() && (!current || page.draft.trim() !== job.prompt)) ||
        (!job.attachments?.length && page.attachments?.length)
      )
        throw new Error("The browser is busy or has a manual draft. Nothing was overwritten.")
      if (!job.parentID && page.users.length) throw new Error("Expected a new empty Chat conversation")
      this.update(job, { userCount: page.users.length, model: page.model, phase: "sending" })
      this.stage(job, "compose")
      if (job.attachments?.length) {
        await this.ensureAttachments(job)
        if (!(await this.checkpoint(job))) return
        page = await this.driver.page()
        if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
        if (!page.targetModel || page.generating || (page.draft.trim() && (!current || page.draft.trim() !== job.prompt)))
          throw new Error("Composer changed during attachment upload. No prompt was submitted.")
      }
      if (!current || page.draft.trim() !== job.prompt) await this.driver.fill(job.prompt)
      if (!(await this.checkpoint(job))) return
      page = await this.driver.page()
      if (
        page.draft.trim() !== job.prompt ||
        !page.targetModel ||
        !this.hasExactAttachmentEvidence(job, page)
      )
        throw new Error("Exact prompt and attachment evidence must be present immediately before sending")
      this.stage(job, "submit")
      const sendURL = page.url
      await this.driver.submit(async () => {
        if (this.disposed || this.active !== job.id || job.phase !== "sending" || this.controlling.has(job.id))
          throw new Error("Consultation was paused or cancelled before the send boundary. Nothing was dispatched.")
        const current = await this.driver.page()
        if (
          current.error ||
          current.url !== sendURL ||
          !current.targetModel ||
          current.generating ||
          current.draft.trim() !== job.prompt ||
          current.users.length !== (job.userCount ?? 0) ||
          !this.hasExactAttachmentEvidence(job, current)
        )
          throw new Error("Composer or attachment evidence changed at the send boundary. Nothing was dispatched.")
        this.update(job, { submitted: true, sendAttempted: true })
      })
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
        (page.users.length === expectedCount && user?.text.trim() !== job.prompt) ||
        (user ? this.hasUnexpectedUserAttachments(job, user) : false)
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
      if (!this.hasExactUserAttachmentEvidence(job, user)) {
        if (Date.now() - submittedAt > 30000)
          throw new Error("Submitted turn attachment evidence did not match. No reply was accepted.")
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
    let page = await this.driver.page()
    if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
    if (
      page.url !== job.url ||
      !page.targetModel ||
      page.generating ||
      page.draft.trim() !== job.prompt ||
      page.users.length !== (job.userCount ?? 0)
    )
      throw new Error("Managed send requires the exact original prompt, verified GPT-6 Pro, and unchanged conversation")
    await this.ensureAttachments(job)
    page = await this.driver.page()
    if (
      page.error ||
      page.url !== job.url ||
      !page.targetModel ||
      page.generating ||
      page.draft.trim() !== job.prompt ||
      !this.hasExactAttachmentEvidence(job, page) ||
      page.users.length !== (job.userCount ?? 0)
    )
      throw new Error("Managed send requires the exact original prompt, verified GPT-6 Pro, and unchanged conversation")
    if (uid && !(await this.driver.element?.(uid))?.send)
      throw new Error("The observed element is not a send control; no question dispatched")
    this.update(job, { model: page.model, userCount: page.users.length })
    this.log(`consult managed recovery send id=${job.id} uid=${uid ?? "website-send-control"}`)
    await this.driver.submit(async () => {
      if (this.disposed || this.active !== job.id || job.phase !== "paused" || !job.recovery || !this.controlling.has(job.id))
        throw new Error("Managed recovery was paused or cancelled before the send boundary. Nothing was dispatched.")
      const current = await this.driver.page()
      if (
        current.error ||
        current.url !== job.url ||
        !current.targetModel ||
        current.generating ||
        current.draft.trim() !== job.prompt ||
        current.users.length !== (job.userCount ?? 0) ||
        !this.hasExactAttachmentEvidence(job, current)
      )
        throw new Error("Composer or attachment evidence changed at the send boundary. Nothing was dispatched.")
      this.update(job, { submitted: true, sendAttempted: true })
    }, uid)
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
      if (!readOnly) {
        const current = await this.driver.page().catch(() => undefined)
        if (current?.error?.kind === "verification")
          throw new Error("Human browser verification is required; all agent browser mutations are blocked")
      }
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
        if (name === "click" && element.retry && (job.sendAttempted === true || job.submitted))
          throw new Error("Retry/regenerate controls are blocked after a send attempt; the original question will not be repeated")
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
        user?.text.trim() === job.prompt &&
        !!user &&
        this.hasExactUserAttachmentEvidence(job, user)
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
    const user = page.users.at(-1)
    const submittedPromptVisible =
      page.users.length === (job.userCount ?? 0) + 1 && user?.text.trim() === job.prompt
    if (
      job.submitted &&
      !job.userID &&
      (!page.users.length || submittedPromptVisible) &&
      isGptProOrigin(page.url) &&
      new URL(page.url).pathname.startsWith("/c/") &&
      page.url !== job.url
    ) {
      this.log(`consult pending conversation URL captured id=${job.id}; awaiting question acknowledgment`)
      this.update(job, { url: page.url })
    }
  }
}
