import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  GPT_PRO_URL,
  normalizeGptProConfig,
  gptProTerminal,
  type GptProCommand,
  type GptProAttachment,
  type GptProAttachmentPreview,
  type GptProConfig,
  type GptProJob,
  type GptProPhase,
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
  hasPage?(): boolean
  boundPageEpoch?(): number | undefined
  ready(): Promise<GptProPageState>
  page(): Promise<GptProPageState>
  observeModel(): Promise<GptProPageState>
  fill(prompt: string): Promise<void>
  uploadAttachments?(
    files: Array<{ path: string; name: string; mime?: string; sha256?: string }>,
    mayDispatch: boolean,
    shouldContinue?: () => Promise<boolean>,
    beforeDispatch?: () => Promise<void>,
  ): Promise<void>
  submit(beforeDispatch?: () => Promise<void | (() => void)>, uid?: string): Promise<void>
  element?(uid: string): Promise<{ composer: boolean; send: boolean; retry?: boolean }>
  recover?(): void
  stop(): Promise<void>
  show?(url?: string): Promise<void>
  focus?(): Promise<void>
  dispose?(): void
}
type DriverSource = GptProDriverAPI | ((job: GptProJob) => GptProDriverAPI)
type Persistence = {
  load(): GptProJob[]
  save(jobs: GptProJob[]): void
  config(): GptProConfig
  setConfig(config: GptProConfig): void
  stagingRoot?(): string
}
export type GptProManagedPage = {
  pageID: string
  epoch: number
  lastActivity: number
  protected: boolean
}
export type GptProPageResources = {
  list(): GptProManagedPage[]
  inspect(pageID: string, epoch: number): Promise<GptProPageState>
  stop(pageID: string, epoch: number): Promise<void>
  close(pageID: string, epoch: number, reason: string): boolean
  setFocus(pageID: string, epoch: number, enabled: boolean): Promise<boolean>
  onClosed(listener: (pageID: string, epoch: number, reason?: string) => void): () => void
  onProtectionChanged(listener: () => void): () => void
}
export type GptProLifecycleOptions = {
  resources: GptProPageResources
  graceMs?: number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}
type TerminalPageProof = {
  jobID: string
  pageID: string
  phase: "completed" | "cancelled" | "failed"
  url: string
  promptHash: string
  userID?: string
  userCount?: number
  submitted?: boolean
  sendAttempted?: boolean
  attachmentIdentities: string[]
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
  previewSha256?: string
}) =>
  attachment.kind === "image" || attachment.mime?.startsWith("image/")
    ? `image:${attachment.previewSha256 ?? attachment.sha256 ?? "unknown"}`
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
const ownerPage = (owner: string) => {
  const separator = owner.lastIndexOf("\n")
  if (separator < 0) return undefined
  return { directory: owner.slice(0, separator), sessionID: owner.slice(separator + 1) }
}
const isUnfinished = (job: GptProJob) =>
  !["completed", "cancelled", "failed"].includes(job.phase)
const isDiscardable = (job: GptProJob) => ["completed", "cancelled", "failed"].includes(job.phase)
const hasSendAttempt = (job: GptProJob) => job.sendAttempted === true
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
  private pumpRequested = false
  private running = new Map<string, Promise<void>>()
  private pendingWork = new Map<string, Promise<void>>()
  private activeOwners = new Set<string>()
  private runTokens = new Map<string, number>()
  private interrupts = new Map<string, () => void>()
  private drivers = new Map<string, GptProDriverAPI>()
  private disposed = false
  private controlling = new Set<string>()
  private mutating = new Set<string>()
  private inspecting = new Map<string, number>()
  private pendingOps = new Map<string, number>()
  private creating = new Map<string, Promise<GptProJob>>()
  private ownerCancelEpoch = new Map<string, number>()
  private stages = new Map<string, GptProRecovery["stage"]>()
  private pageReservations = new Map<string, string>()
  private cleanupTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; epoch: number; token: number }>()
  private cleanupBlocked = new Map<string, { epoch: number; reason: string; attempts: number }>()
  private cleanupSequence = 0
  private focusState = new Map<string, boolean>()
  private driverBindings = new Map<string, { pageID: string; epoch?: number }>()
  private terminalPageProofs = new Map<string, TerminalPageProof>()
  private lifecycleUnsubscribes: Array<() => void> = []
  private readonly lifecycle?: GptProLifecycleOptions
  constructor(
    private readonly driverSource: DriverSource,
    private readonly persistence: Persistence,
    private readonly log: (message: string) => void,
    private readonly pollMs = 1000,
    private readonly stableMs = 3000,
    lifecycle?: GptProLifecycleOptions,
  ) {
    this.lifecycle = lifecycle
    this.jobs = persistence.load().map((job) => {
      const migrated = {
        ...job,
        pageID: `gpt-pro-page-${job.id}`,
        profileID: GPT_PRO_PARTITION,
        ownerPage: ownerPage(job.owner),
      }
      if (["completed", "cancelled", "failed"].includes(job.phase)) return migrated
      if (job.sendAttempted === true && !job.userID)
        return {
          ...migrated,
          phase: "send_uncertain" as const,
          error: "Application restarted before the submitted turn could be confirmed. Never resend automatically.",
        }
      if (job.phase === "paused" || job.phase === "send_uncertain") return migrated
      if (job.background && job.submitted && job.userID)
        return { ...migrated, phase: "queued" as const, resumeCurrentPage: false, error: undefined }
      if (gptProTerminal(job.phase)) return migrated
      return {
        ...migrated,
        phase: "interrupted" as const,
        error: "Application restarted before submission. Resume explicitly; do not send automatically.",
      }
    })
    for (const job of this.jobs) this.rememberTerminalPageProof(job)
    this.save()
    if (lifecycle) {
      this.lifecycleUnsubscribes.push(
        lifecycle.resources.onClosed((pageID, epoch, reason) => this.onManagedPageClosed(pageID, epoch, reason)),
        lifecycle.resources.onProtectionChanged(() => this.reconcilePageLifecycle(true)),
      )
      this.reconcilePageLifecycle()
    }
    void this.pump()
  }
  config() {
    return normalizeGptProConfig(this.persistence.config())
  }
  busy() {
    return this.running.size > 0 || this.jobs.some(isUnfinished)
  }
  setConfig(config: GptProConfig) {
    const next = normalizeGptProConfig(config)
    this.persistence.setConfig(next)
    void this.pump()
    return next
  }
  list() {
    return this.jobs.map((job) => {
      const {
        html: _html,
        text: _text,
        notifications: _notifications,
        notificationText: _notificationText,
        ...visible
      } = job
      return this.publicJob({ ...visible, prompt: visible.prompt.slice(0, 160) })
    })
  }
  async attachmentPreview(input: { id: string; attachmentID: string }): Promise<GptProAttachmentPreview> {
    if (
      !input ||
      typeof input.id !== "string" ||
      typeof input.attachmentID !== "string" ||
      !/^gpt_[a-f0-9-]+$/i.test(input.id) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.attachmentID)
    ) {
      throw new Error("Stored attachment preview is not available")
    }
    const job = this.jobs.find((item) => item.id === input.id)
    const attachment = job?.attachments?.find((item) => item.id === input.attachmentID)
    const staged = job?.stagedAttachments?.find((item) => item.id === input.attachmentID)
    if (!job || !attachment || !staged) throw new Error("Stored attachment preview is not available")

    const stagingRoot = this.persistence.stagingRoot?.()
    if (!stagingRoot) throw new Error("Owned attachment storage is unavailable")
    const filename = attachment.uploadName
    if (
      !filename ||
      filename.includes("/") ||
      filename.includes("\\") ||
      path.basename(filename) !== filename ||
      staged.uploadName !== filename ||
      !path.isAbsolute(staged.path)
    ) {
      throw new Error("Stored attachment identity is invalid")
    }

    const root = await realpath(stagingRoot).catch(() => undefined)
    if (!root) throw new Error("Owned attachment storage is unavailable")
    const jobRoot = path.join(root, job.id)
    const attachmentRoot = path.join(jobRoot, attachment.id)
    const expectedPath = path.join(attachmentRoot, filename)
    const canonicalStagedPath = await realpath(staged.path).catch(() => undefined)
    if (!canonicalStagedPath) throw new Error("Stored attachment preview is unavailable or changed")
    if (canonicalStagedPath !== expectedPath) {
      throw new Error("Stored attachment is outside its owned job directory")
    }

    try {
      const [resolvedJobRoot, resolvedAttachmentRoot] = await Promise.all([realpath(jobRoot), realpath(attachmentRoot)])
      if (resolvedJobRoot !== jobRoot || resolvedAttachmentRoot !== attachmentRoot) {
        throw new Error("Stored attachment copy is outside its owned directory")
      }
      const [jobInfo, attachmentInfo, fileInfo] = await Promise.all([
        lstat(jobRoot),
        lstat(attachmentRoot),
        lstat(expectedPath),
      ])
      if (
        jobInfo.isSymbolicLink() ||
        !jobInfo.isDirectory() ||
        attachmentInfo.isSymbolicLink() ||
        !attachmentInfo.isDirectory() ||
        fileInfo.isSymbolicLink() ||
        !fileInfo.isFile() ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0 ||
        attachment.size > ATTACHMENT_FILE_LIMIT ||
        fileInfo.size !== attachment.size ||
        staged.sha256 !== attachment.sha256 ||
        !/^[a-f0-9]{64}$/i.test(staged.sha256)
      ) {
        throw new Error("Stored attachment copy is missing or changed")
      }

      const handle = await open(expectedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      try {
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          opened.size !== attachment.size ||
          opened.size > ATTACHMENT_FILE_LIMIT ||
          Number(opened.dev) !== Number(fileInfo.dev) ||
          Number(opened.ino) !== Number(fileInfo.ino)
        ) {
          throw new Error("Stored attachment copy is missing or changed")
        }
        const chunks: Buffer[] = []
        const chunk = Buffer.alloc(64 * 1024)
        let size = 0
        while (true) {
          const length = Math.min(chunk.byteLength, Math.max(1, attachment.size - size + 1))
          const result = await handle.read(chunk, 0, length, null)
          if (!result.bytesRead) break
          size += result.bytesRead
          if (size > attachment.size || size > ATTACHMENT_FILE_LIMIT) {
            throw new Error("Stored attachment copy is missing or changed")
          }
          chunks.push(Buffer.from(chunk.subarray(0, result.bytesRead)))
        }
        const after = await handle.stat()
        const resolvedFilePath = await realpath(expectedPath)
        if (
          size !== attachment.size ||
          after.size !== attachment.size ||
          Number(after.dev) !== Number(opened.dev) ||
          Number(after.ino) !== Number(opened.ino) ||
          resolvedFilePath !== expectedPath
        ) {
          throw new Error("Stored attachment copy is missing or changed")
        }
        bytes = Buffer.concat(chunks, size)
      } finally {
        await handle.close()
      }

      if (digest(bytes) !== staged.sha256.toLowerCase()) {
        throw new Error("Stored attachment copy is missing or changed")
      }
      const mime = attachmentTypes.get(path.extname(attachment.name).toLowerCase())
      if (!mime || mime !== attachment.mime) throw new Error("Stored attachment type is invalid")
      this.log(
        `consult attachment preview ready job=${job.id} attachment=${attachment.id} bytes=${bytes.byteLength} mime=${mime}`,
      )
      return { name: attachment.name, mime, base64: bytes.toString("base64") }
    } catch (error) {
      this.log(`consult attachment preview refused job=${job.id} attachment=${attachment.id}`)
      if (error instanceof Error && error.message === "Stored attachment type is invalid") throw error
      throw new Error("Stored attachment preview is unavailable or changed")
    }
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
    for (const unsubscribe of this.lifecycleUnsubscribes.splice(0)) unsubscribe()
    for (const pageID of [...this.cleanupTimers.keys()]) this.clearPageCleanup(pageID, "controller-dispose")
    for (const job of this.jobs) {
      this.interrupts.get(job.id)?.()
      if (job.phase === "paused" || gptProTerminal(job.phase)) continue
      if (job.background && job.submitted && job.userID) {
        this.update(job, {
          phase: "generating",
          error: "Application stopped. Resume tracking the original confirmed turn; never resend.",
        })
        continue
      }
      if (job.sendAttempted === true && !job.userID)
        this.update(job, {
          phase: "send_uncertain",
          error: "Application stopped before the submitted turn could be confirmed. Never resend automatically.",
        })
      else
        this.update(job, {
          phase: "interrupted",
          error: "Application stopped. Resume explicitly; never resend automatically.",
        })
    }
    for (const driver of this.drivers.values()) driver.dispose?.()
    this.drivers.clear()
    this.log(`consult lifecycle disposed timers=0 observers=0 drivers=0`)
  }
  private save() {
    const previous = this.jobs
    const retained = new Set(
      this.jobs
        .filter((job) =>
          isDiscardable(job) &&
          this.isQuiescent(job.id) &&
          !this.pageIsProtected(this.pageID(job)),
        )
        .slice(-30)
        .map((job) => job.id),
    )
    this.jobs = this.jobs.filter(
      (job) =>
        !isDiscardable(job) ||
        !this.isQuiescent(job.id) ||
        this.pageIsProtected(this.pageID(job)) ||
        retained.has(job.id) ||
        !!job.notifications?.length,
    )
    const remaining = new Set(this.jobs.map((job) => job.id))
    const removed = previous.filter((job) => !remaining.has(job.id))
    this.persistence.save(this.jobs)
    for (const job of removed) {
      this.releaseDriver(job.id, "history-pruned")
      if (!this.pageExists(this.pageID(job))) this.terminalPageProofs.delete(this.pageID(job))
      if (!job.stagedAttachments?.length) continue
      const root = this.persistence.stagingRoot?.()
      if (!/^gpt_[a-f0-9-]+$/i.test(job.id)) continue
      const owned = root && path.join(root, job.id)
      if (
        owned &&
        job.stagedAttachments.every((file) => {
          const relative = path.relative(owned, file.path)
          return (
            relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
          )
        })
      ) {
        void rm(owned, { recursive: true, force: true }).then(
          () => this.log(`consult attachment staging cleaned job=${job.id}`),
          () => this.log(`consult attachment staging cleanup failed job=${job.id}`),
        )
      }
    }
    this.reconcilePageLifecycle()
  }
  private update(job: GptProJob, input: Partial<GptProJob>) {
    const previous = job.phase
    Object.assign(job, input, { updatedAt: Date.now() })
    this.rememberTerminalPageProof(job)
    this.save()
    if (previous !== job.phase) this.log(`consult id=${job.id} phase=${job.phase} revision=${job.revision}`)
    this.notify(job)
    this.reconcilePageLifecycle()
  }
  private publicJob(job: GptProJob): GptProJob {
    const attachments = job.attachments?.map(({ path: _path, ...attachment }) => ({ ...attachment }))
    const { stagedAttachments: _stagedAttachments, ...result } = job
    return { ...result, ...(attachments ? { attachments } : {}) }
  }
  private pageID(job: GptProJob) {
    return job.pageID ?? `gpt-pro-page-${job.id}`
  }
  private pageIsProtected(pageID: string) {
    return this.lifecycle?.resources.list().some((page) => page.pageID === pageID && page.protected) ?? false
  }
  private pageExists(pageID: string) {
    return this.lifecycle?.resources.list().some((page) => page.pageID === pageID) ?? false
  }
  private isQuiescent(jobID: string) {
    return (
      !this.running.has(jobID) &&
      !this.pendingWork.has(jobID) &&
      !this.mutating.has(jobID) &&
      !this.inspecting.has(jobID) &&
      !this.pendingOps.has(jobID) &&
      !this.controlling.has(jobID)
    )
  }
  private releaseDriver(jobID: string, reason: string, expected?: { pageID: string; epoch: number }) {
    const driver = this.drivers.get(jobID)
    if (!driver) return false
    const binding = this.driverBindings.get(jobID)
    const actualEpoch = driver.boundPageEpoch?.() ?? binding?.epoch
    const job = this.jobs.find((item) => item.id === jobID)
    const actualPageID = binding?.pageID ?? (job ? this.pageID(job) : "unknown")
    if (expected && (actualPageID !== expected.pageID || (actualEpoch !== undefined && actualEpoch !== expected.epoch))) {
      this.log(`consult driver release ignored id=${jobID} expectedPageID=${expected.pageID} expectedEpoch=${expected.epoch} actualPageID=${actualPageID} actualEpoch=${actualEpoch ?? "unknown"}`)
      return false
    }
    driver.dispose?.()
    this.drivers.delete(jobID)
    this.driverBindings.delete(jobID)
    this.log(`consult driver released id=${jobID} pageID=${actualPageID} epoch=${actualEpoch ?? "unknown"} reason=${reason}`)
    return true
  }
  private releaseExecution(job: GptProJob, reason: string) {
    return this.releaseExecutionByID(job.id, this.pageID(job), reason, job.phase)
  }
  private releaseExecutionByID(jobID: string, pageID: string, reason: string, phase?: string) {
    if (!this.isQuiescent(jobID)) return false
    const hadResources =
      this.drivers.has(jobID) ||
      this.runTokens.has(jobID) ||
      this.interrupts.has(jobID) ||
      this.stages.has(jobID) ||
      this.pageReservations.has(pageID)
    if (!hadResources) return false
    this.releaseDriver(jobID, reason)
    this.runTokens.delete(jobID)
    this.interrupts.delete(jobID)
    this.stages.delete(jobID)
    this.pageReservations.delete(pageID)
    this.log(`consult execution resources released id=${jobID} phase=${phase ?? "pruned"} reason=${reason}`)
    this.reconcilePageLifecycle()
    void this.pump()
    return true
  }
  private clearPageCleanup(pageID: string, reason: string) {
    const record = this.cleanupTimers.get(pageID)
    if (!record) return
    const clear = this.lifecycle?.clearTimeout ?? clearTimeout
    clear(record.timer)
    this.cleanupTimers.delete(pageID)
    this.log(`consult page cleanup timer cleared pageID=${pageID} epoch=${record.epoch} token=${record.token} reason=${reason}`)
  }
  private blockPageCleanup(pageID: string, epoch: number, reason: string) {
    const previous = this.cleanupBlocked.get(pageID)
    const attempts = previous?.epoch === epoch ? Math.min(previous.attempts + 1, 4) : 1
    this.cleanupBlocked.set(pageID, { epoch, reason, attempts })
    const delay = Math.min(60_000 * 2 ** (attempts - 1), 300_000)
    this.log(`consult page cleanup blocked pageID=${pageID} epoch=${epoch} reason=${reason} retryMs=${delay}`)
    const page = this.lifecycle?.resources.list().find((page) => page.pageID === pageID && page.epoch === epoch)
    if (!page || page.protected || this.disposed || this.cleanupTimers.has(pageID)) return
    this.schedulePageCleanup(page, delay)
  }
  private schedulePageCleanup(page: GptProManagedPage, delay: number) {
    if (!this.lifecycle) return
    const token = ++this.cleanupSequence
    const schedule = this.lifecycle.setTimeout ?? setTimeout
    const handle = schedule(() => void this.cleanupTerminalPage(page.pageID, page.epoch, token), delay)
    ;(handle as unknown as { unref?: () => void }).unref?.()
    this.cleanupTimers.set(page.pageID, { timer: handle, epoch: page.epoch, token })
    this.log(`consult page cleanup scheduled pageID=${page.pageID} epoch=${page.epoch} token=${token} graceMs=${delay}`)
  }
  private setTerminalFocus(page: GptProManagedPage, enabled: boolean) {
    const key = `${page.pageID}\n${page.epoch}`
    if (this.focusState.get(key) === enabled) return
    this.focusState.set(key, enabled)
    void this.lifecycle?.resources.setFocus(page.pageID, page.epoch, enabled).then((applied) => {
      if (!applied) {
        if (this.focusState.get(key) === enabled) this.focusState.delete(key)
        this.log(`consult terminal focus update skipped pageID=${page.pageID} epoch=${page.epoch} enabled=${enabled}`)
      }
    }).catch((error) => {
      if (this.focusState.get(key) === enabled) this.focusState.delete(key)
      this.log(`consult terminal focus update failed pageID=${page.pageID} epoch=${page.epoch} enabled=${enabled} error=${String(error)}`)
    })
    this.log(`consult terminal focus update pageID=${page.pageID} epoch=${page.epoch} enabled=${enabled}`)
  }
  private reconcilePageLifecycle(retryBlocked = false) {
    const lifecycle = this.lifecycle
    if (!lifecycle || this.disposed) return
    if (retryBlocked) this.cleanupBlocked.clear()
    const pages = lifecycle.resources.list()
    const existing = new Map(pages.map((page) => [page.pageID, page]))
    for (const [pageID, blocked] of this.cleanupBlocked) {
      const current = existing.get(pageID)
      if (!current || current.epoch !== blocked.epoch) this.cleanupBlocked.delete(pageID)
    }
    for (const [pageID, timer] of this.cleanupTimers) {
      const current = existing.get(pageID)
      if (!current || current.epoch !== timer.epoch) this.clearPageCleanup(pageID, "page-replaced-or-closed")
    }
    for (const page of pages) {
      const job = this.jobs.find((candidate) => this.pageID(candidate) === page.pageID)
      const proof = this.terminalPageProofs.get(page.pageID)
      const jobID = job?.id ?? proof?.jobID
      if (!jobID || (job && !isDiscardable(job)) || !this.isQuiescent(jobID)) {
        this.clearPageCleanup(page.pageID, "page-protected-by-job-state")
        if (page.protected) this.setTerminalFocus(page, true)
        continue
      }
      if (page.protected) {
        this.clearPageCleanup(page.pageID, "page-viewed")
        this.setTerminalFocus(page, true)
        continue
      }
      if (this.cleanupBlocked.get(page.pageID)?.epoch === page.epoch) continue
      // A terminal job may now contain a manual draft or a new website generation.
      // Keep its scheduling active until inspection proves the page safe to close.
      this.setTerminalFocus(page, true)
      const timer = this.cleanupTimers.get(page.pageID)
      if (timer?.epoch === page.epoch) continue
      this.schedulePageCleanup(page, lifecycle.graceMs ?? 30_000)
    }
    for (const job of this.jobs) {
      if (isDiscardable(job) && this.isQuiescent(job.id) && !existing.has(this.pageID(job)))
        this.releaseExecution(job, "terminal-page-absent")
    }
    void this.pump()
  }
  private async cleanupTerminalPage(pageID: string, epoch: number, token: number) {
    const record = this.cleanupTimers.get(pageID)
    if (!record || record.epoch !== epoch || record.token !== token) return
    const lifecycle = this.lifecycle
    const pageBefore = lifecycle?.resources.list().find((item) => item.pageID === pageID)
    const job = this.jobs.find((candidate) => this.pageID(candidate) === pageID)
    const proof = this.terminalPageProofs.get(pageID)
    const jobID = job?.id ?? proof?.jobID
    if (
      !lifecycle ||
      !pageBefore ||
      pageBefore.epoch !== epoch ||
      pageBefore.protected ||
      !jobID ||
      (job && !isDiscardable(job)) ||
      !this.isQuiescent(jobID)
    ) {
      this.log(`consult page cleanup skipped pageID=${pageID} epoch=${epoch} token=${token} reason=stale-viewed-or-active`)
      this.clearPageCleanup(pageID, "cleanup-skipped")
      this.reconcilePageLifecycle()
      return
    }
    if (!job && !proof) {
      this.log(`consult page cleanup skipped pageID=${pageID} epoch=${epoch} token=${token} reason=missing-job-proof`)
      this.clearPageCleanup(pageID, "missing-job-proof")
      return
    }
    let page: GptProPageState
    try {
      page = await lifecycle.resources.inspect(pageID, epoch)
    } catch (error) {
      this.log(`consult page cleanup inspection failed pageID=${pageID} epoch=${epoch} token=${token} error=${String(error)}`)
      this.clearPageCleanup(pageID, "inspection-failed")
      this.blockPageCleanup(pageID, epoch, "inspection-unavailable")
      return
    }
    const current = lifecycle.resources.list().find((item) => item.pageID === pageID)
    const currentJob = this.jobs.find((candidate) => this.pageID(candidate) === pageID)
    const currentProof = this.terminalPageProofs.get(pageID)
    const currentJobID = currentJob?.id ?? currentProof?.jobID
    if (this.cleanupTimers.get(pageID)?.token !== token) {
      this.log(`consult page cleanup ignored stale callback pageID=${pageID} epoch=${epoch} token=${token}`)
      return
    }
    if (
      this.disposed ||
      !current ||
      current.epoch !== epoch ||
      current.protected ||
      !currentJobID ||
      (currentJob && !isDiscardable(currentJob)) ||
      !this.isQuiescent(currentJobID) ||
      !(currentJob ? this.safeToCloseTerminalPage(currentJob, page) : currentProof && this.safeToCloseByProof(currentProof, page))
    ) {
      this.log(`consult page cleanup preserved pageID=${pageID} epoch=${epoch} token=${token} reason=page-state-or-lease-changed`)
      this.clearPageCleanup(pageID, "state-changed")
      if (current && current.epoch === epoch && !current.protected && currentJobID)
        this.blockPageCleanup(pageID, epoch, "page-state-changed-or-unsafe")
      else this.reconcilePageLifecycle()
      return
    }
    const closed = lifecycle.resources.close(pageID, epoch, "terminal-grace-expired")
    this.log(`consult page cleanup close pageID=${pageID} epoch=${epoch} token=${token} outcome=${closed ? "closed" : "stale"}`)
    if (closed) {
      this.focusState.delete(`${pageID}\n${epoch}`)
      this.terminalPageProofs.delete(pageID)
      this.releaseDriver(currentJobID, "terminal-page-closed", { pageID, epoch })
      if (currentJob) this.releaseExecution(currentJob, "terminal-page-closed")
      else this.releaseExecutionByID(currentJobID, pageID, "terminal-page-closed")
      this.save()
    }
  }
  private safeToCloseTerminalPage(job: GptProJob, page: GptProPageState) {
    this.rememberTerminalPageProof(job)
    const proof = this.terminalPageProofs.get(this.pageID(job))
    return proof ? this.safeToCloseByProof(proof, page) : false
  }
  private rememberTerminalPageProof(job: GptProJob) {
    if (!isDiscardable(job)) return
    const pageID = this.pageID(job)
    this.terminalPageProofs.set(pageID, {
      jobID: job.id,
      pageID,
      phase: job.phase as TerminalPageProof["phase"],
      url: job.url,
      promptHash: digest(Buffer.from(job.prompt.trim())),
      userID: job.userID,
      userCount: job.userCount,
      submitted: job.submitted,
      sendAttempted: job.sendAttempted,
      attachmentIdentities: (job.attachments ?? []).map(attachmentIdentity).sort(),
    })
  }
  private safeToCloseByProof(proof: TerminalPageProof, page: GptProPageState) {
    if (page.error || page.generating || page.url !== proof.url) return false
    const expectedAttachments = proof.attachmentIdentities
    const pageAttachments = (page.attachments ?? []).map(attachmentIdentity).sort()
    const attachmentsMatch =
      pageAttachments.length === expectedAttachments.length &&
      pageAttachments.every((identity, index) => identity === expectedAttachments[index]) &&
      (page.attachments ?? []).every((attachment) => attachment.status === "ready")
    const ownedUnsentDraft =
      proof.phase === "cancelled" &&
      digest(Buffer.from(page.draft.trim())) === proof.promptHash &&
      attachmentsMatch
    if (page.attachments?.length && !ownedUnsentDraft) return false
    if (page.draft.trim()) {
      if (!ownedUnsentDraft) return false
    }
    const expectedUsers = proof.userID ? (proof.userCount ?? 0) + 1 : proof.userCount ?? 0
    if (page.users.length !== expectedUsers) return false
    if (proof.userID) {
      const user = page.users.find((candidate) => candidate.id === proof.userID)
      const identities = (user?.attachments ?? []).map(attachmentIdentity).sort()
      if (
        !user ||
        digest(Buffer.from(user.text.trim())) !== proof.promptHash ||
        identities.length !== expectedAttachments.length ||
        identities.some((identity, index) => identity !== expectedAttachments[index]) ||
        (user.attachments ?? []).some((attachment) => attachment.status !== "ready")
      )
        return false
    } else if (proof.submitted || proof.sendAttempted) {
      return false
    }
    return true
  }
  private onManagedPageClosed(pageID: string, epoch: number, reason = "manual-close") {
    this.clearPageCleanup(pageID, reason)
    const job = this.jobs.find((candidate) => this.pageID(candidate) === pageID)
    const proof = this.terminalPageProofs.get(pageID)
    if (job && !isDiscardable(job)) {
      const uncertain = job.sendAttempted === true && !job.userID
      this.update(job, {
        phase: uncertain ? "send_uncertain" : "paused",
        error: uncertain ? "The consultation page closed before submission could be confirmed. Never resend." : "The consultation page closed. Resume explicitly to reopen its original URL.",
        recovery: uncertain ? undefined : { stage: this.stages.get(job.id) ?? "open", reason: "Consultation page closed" },
        resumeCurrentPage: false,
      })
      this.interrupts.get(job.id)?.()
      this.log(`consult page closure fenced active job id=${job.id} pageID=${pageID} epoch=${epoch} phase=${job.phase} reason=${reason}`)
    }
    const jobID = job?.id ?? proof?.jobID
    if (jobID) this.releaseDriver(jobID, reason, { pageID, epoch })
    this.focusState.delete(`${pageID}\n${epoch}`)
    if (jobID && this.isQuiescent(jobID)) {
      if (job) this.releaseExecution(job, `page-closed:${reason}`)
      else this.releaseExecutionByID(jobID, pageID, `page-closed:${reason}`)
    }
    this.terminalPageProofs.delete(pageID)
    this.save()
    this.reconcilePageLifecycle()
  }
  private driverFor(job: GptProJob) {
    const existing = this.drivers.get(job.id)
    if (existing) return existing
    const driver = typeof this.driverSource === "function" ? this.driverSource(job) : this.driverSource
    this.drivers.set(job.id, driver)
    return driver
  }
  private ownerBusy(owner: string, exceptID?: string) {
    return this.jobs.find((job) => job.id !== exceptID && job.owner === owner && isUnfinished(job))
  }
  private schedulerOwnerBlocker(job: GptProJob) {
    const candidateIndex = this.jobs.indexOf(job)
    return this.jobs.find((other, index) => {
      if (other.id === job.id || other.owner !== job.owner || !isUnfinished(other)) return false
      return other.phase !== "queued" || index < candidateIndex
    })
  }
  private allocationTail: Promise<void> = Promise.resolve()
  private async reservePage(job: GptProJob) {
    const lifecycle = this.lifecycle
    if (!lifecycle) return true
    let unlock!: () => void
    const previous = this.allocationTail
    this.allocationTail = new Promise<void>((resolve) => (unlock = resolve))
    await previous
    try {
      const pageID = this.pageID(job)
      const current = lifecycle.resources.list().find((page) => page.pageID === pageID)
      if (current) return true
      const reservedBy = this.pageReservations.get(pageID)
      if (reservedBy) return reservedBy === job.id
      const limit = this.config().maxResidentPages ?? 8
      const reservationCount = () =>
        [...this.pageReservations.keys()].filter((id) => !lifecycle.resources.list().some((page) => page.pageID === id)).length
      while (lifecycle.resources.list().length + reservationCount() >= limit) {
        const pages = lifecycle.resources
          .list()
          .filter((candidate) => {
            const candidateJob = this.jobs.find((item) => this.pageID(item) === candidate.pageID)
            return (
              !candidate.protected &&
              this.cleanupBlocked.get(candidate.pageID)?.epoch !== candidate.epoch &&
              !!candidateJob &&
              isDiscardable(candidateJob) &&
              this.isQuiescent(candidateJob.id) &&
              candidate.pageID !== pageID
            )
          })
          .sort((a, b) => a.lastActivity - b.lastActivity)
        let evicted = false
        for (const candidate of pages) {
          const candidateJob = this.jobs.find((item) => this.pageID(item) === candidate.pageID)
          if (!candidateJob) continue
          let state: GptProPageState
          try {
            state = await lifecycle.resources.inspect(candidate.pageID, candidate.epoch)
          } catch (error) {
            this.log(`consult page eviction inspection failed pageID=${candidate.pageID} epoch=${candidate.epoch} error=${String(error)}`)
            this.blockPageCleanup(candidate.pageID, candidate.epoch, "inspection-unavailable")
            continue
          }
          const latest = lifecycle.resources.list().find((item) => item.pageID === candidate.pageID)
          if (
            !latest ||
            latest.epoch !== candidate.epoch ||
            latest.protected ||
            !this.isQuiescent(candidateJob.id) ||
            !isDiscardable(candidateJob) ||
            !this.safeToCloseTerminalPage(candidateJob, state)
          ) {
            if (latest && latest.epoch === candidate.epoch && !latest.protected)
              this.blockPageCleanup(candidate.pageID, candidate.epoch, "page-state-changed-or-unsafe")
            continue
          }
          evicted = lifecycle.resources.close(candidate.pageID, candidate.epoch, "resident-budget-eviction")
          this.log(`consult page eviction pageID=${candidate.pageID} epoch=${candidate.epoch} outcome=${evicted ? "closed" : "stale"}`)
          if (evicted) break
        }
        if (!evicted) return false
      }
      this.pageReservations.set(pageID, job.id)
      this.log(`consult page reservation acquired id=${job.id} pageID=${pageID} resident=${lifecycle.resources.list().length} reserved=${reservationCount()} limit=${limit}`)
      return true
    } finally {
      unlock()
    }
  }
  private releasePageReservation(job: GptProJob, reason: string) {
    const pageID = this.pageID(job)
    if (this.pageReservations.get(pageID) !== job.id) return
    this.pageReservations.delete(pageID)
    this.log(`consult page reservation released id=${job.id} pageID=${pageID} reason=${reason}`)
  }
  private async openJobPage(job: GptProJob, driver: GptProDriverAPI, fresh?: boolean, show = false) {
    const pageID = this.pageID(job)
    const existed = this.lifecycle?.resources.list().some((page) => page.pageID === pageID) ?? driver.hasPage?.() ?? true
    if (!existed && !(await this.reservePage(job))) throw new Error("page_capacity: all resident consultation pages are protected or in use")
    try {
      if (show && driver.show) await driver.show(job.url)
      else await driver.open(job.url, fresh)
      const resource = this.lifecycle?.resources.list().find((page) => page.pageID === pageID)
      this.driverBindings.set(job.id, { pageID, epoch: driver.boundPageEpoch?.() ?? resource?.epoch })
      this.log(`consult page opened id=${job.id} pageID=${pageID} epoch=${driver.boundPageEpoch?.() ?? resource?.epoch ?? "unknown"} fresh=${fresh === true} show=${show}`)
    } finally {
      this.releasePageReservation(job, "open-settled")
    }
  }
  cancelOwner(owner: string) {
    const epoch = (this.ownerCancelEpoch.get(owner) ?? 0) + 1
    this.ownerCancelEpoch.set(owner, epoch)
    const jobs = this.jobs.filter((job) => job.owner === owner && isUnfinished(job))
    const drivers = new Map(jobs.map((job) => [job.id, this.drivers.get(job.id)]))
    const pages = new Map(jobs.map((job) => [job.id, this.lifecycle?.resources.list().find((page) => page.pageID === this.pageID(job))]))
    for (const job of jobs) {
      this.update(job, {
        phase: "cancelled",
        error: undefined,
        recovery: undefined,
        queueReason: undefined,
        queueOwnerConsultationID: undefined,
        notifications: job.notifications?.filter((event) => !event.recovery),
      })
      this.interrupts.get(job.id)?.()
    }
    for (const job of jobs) this.stopExistingPage(job, drivers.get(job.id), "owner-cancel", pages.get(job.id))
    this.log(`consult owner cancelled owner=${owner} epoch=${epoch} jobs=${jobs.length}`)
    return jobs.length
  }
  private stopExistingPage(job: GptProJob, driver: GptProDriverAPI | undefined, reason: string, page?: GptProManagedPage) {
    if (!driver && !page) {
      this.log(`consult native stop skipped id=${job.id} pageID=${this.pageID(job)} reason=${reason} detail=no-cached-driver`)
      return
    }
    const pageID = this.pageID(job)
    const epoch = page?.epoch ?? driver?.boundPageEpoch?.() ?? this.driverBindings.get(job.id)?.epoch
    this.log(`consult native stop started id=${job.id} pageID=${pageID} epoch=${epoch ?? "unknown"} reason=${reason}`)
    void this.mutate(job, () => {
      if (page && this.lifecycle) return this.lifecycle.resources.stop(page.pageID, page.epoch)
      if (!driver || (epoch !== undefined && driver.boundPageEpoch?.() !== epoch))
        throw new Error("Native stop lease changed; replacement page was preserved")
      return driver.stop()
    }, true)
      .then(() => this.log(`consult native stop settled id=${job.id} pageID=${pageID} epoch=${epoch ?? "unknown"} outcome=stopped`))
      .catch((error) =>
        this.log(`consult native stop settled id=${job.id} pageID=${pageID} epoch=${epoch ?? "unknown"} outcome=failed error=${String(error)}`),
      )
  }
  private async mutate<A>(job: GptProJob, action: () => Promise<A>, allowCancelled = false) {
    this.pendingOps.set(job.id, (this.pendingOps.get(job.id) ?? 0) + 1)
    let acquired = false
    try {
      while (!this.disposed && (this.mutating.has(job.id) || this.inspecting.has(job.id))) await sleep(5)
      if (this.disposed || (job.phase === "cancelled" && !allowCancelled))
        throw new Error("Consultation was cancelled before page mutation")
      this.mutating.add(job.id)
      acquired = true
      return await action()
    } finally {
      if (acquired) this.mutating.delete(job.id)
      this.endPendingOp(job.id)
    }
  }
  private beginPendingOp(jobID: string) {
    this.pendingOps.set(jobID, (this.pendingOps.get(jobID) ?? 0) + 1)
  }
  private endPendingOp(jobID: string) {
    const count = this.pendingOps.get(jobID) ?? 0
    if (count <= 1) this.pendingOps.delete(jobID)
    else this.pendingOps.set(jobID, count - 1)
    const job = this.jobs.find((item) => item.id === jobID)
    if (job && this.isQuiescent(jobID)) this.releaseExecution(job, "operation-settled")
  }
  private canDispatch(job: GptProJob, runToken?: number) {
    if (this.disposed || job.phase === "cancelled" || job.phase === "send_uncertain") return false
    const managedRecovery = this.controlling.has(job.id) && job.phase === "paused" && !!job.recovery
    const automaticRun =
      runToken !== undefined &&
      this.runTokens.get(job.id) === runToken &&
      this.running.has(job.id) &&
      job.phase === "sending" &&
      !this.controlling.has(job.id)
    return managedRecovery || automaticRun
  }
  private beginInspect(jobID: string) {
    this.inspecting.set(jobID, (this.inspecting.get(jobID) ?? 0) + 1)
  }
  private endInspect(jobID: string) {
    const count = this.inspecting.get(jobID) ?? 0
    if (count <= 1) this.inspecting.delete(jobID)
    else this.inspecting.set(jobID, count - 1)
    const job = this.jobs.find((item) => item.id === jobID)
    if (job && this.isQuiescent(jobID)) this.releaseExecution(job, "inspection-settled")
  }
  private async inspectPage(job: GptProJob, driver = this.driverFor(job)) {
    this.beginPendingOp(job.id)
    try {
      while (!this.disposed && this.mutating.has(job.id)) await sleep(5)
      this.beginInspect(job.id)
      try {
        return await driver.page()
      } finally {
        this.endInspect(job.id)
      }
    } finally {
      this.endPendingOp(job.id)
    }
  }
  private unconfirmedPhase(job: GptProJob): GptProPhase {
    return job.sendAttempted === true && !job.userID ? "send_uncertain" : "paused"
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
        if (attachmentTypes.get(extension) !== attachment.mime) throw new Error("Attachment type is not supported")
        if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > ATTACHMENT_FILE_LIMIT)
          throw new Error("Each attachment must be at most 20 MiB")
        if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) throw new Error("Attachment digest is invalid")
        const info = await lstat(attachment.path)
        if (
          !path.isAbsolute(attachment.path) ||
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== attachment.size
        )
          throw new Error("Attachment source changed or is not a regular file")
        const handle = await open(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.size !== attachment.size)
            throw new Error("Attachment source changed during validation")
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
        this.log(
          `consult attachment staged job=${jobID} index=${index + 1} bytes=${bytes.byteLength} digestVerified=true`,
        )
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
    createEpoch = this.ownerCancelEpoch.get(jobOwner) ?? 0,
  ) {
    const jobID = `gpt_${randomUUID()}`
    const stagedAttachments = await this.stageAttachments(jobID, input.attachments ?? [])
    try {
      if ((this.ownerCancelEpoch.get(jobOwner) ?? 0) !== createEpoch)
        throw new Error("owner_session_cancelled: consultation creation was revoked while staging")
      if (parent && isUnfinished(parent)) await this.command({ action: "stop", id: parent.id }, owner)
      if ((this.ownerCancelEpoch.get(jobOwner) ?? 0) !== createEpoch)
        throw new Error("owner_session_cancelled: consultation creation was revoked before admission")
      const busy = this.ownerBusy(jobOwner, parent?.id)
      if (busy) throw new Error(`owner_page_busy: consultation ${busy.id} is still ${busy.phase}`)
      const ownerContext = ownerPage(jobOwner)
      const job: GptProJob = {
        id: jobID,
        pageID: `gpt-pro-page-${jobID}`,
        profileID: GPT_PRO_PARTITION,
        ...(ownerContext ? { ownerPage: ownerContext } : {}),
        owner: jobOwner,
        requestID,
        ...(parent ? { parentID: parent.id } : {}),
        phase: "queued",
        prompt: input.prompt!.trim(),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((attachment, index) => ({
                id: attachment.id,
                name: attachment.name,
                path: attachment.path,
                mime: attachment.mime,
                size: attachment.size,
                sha256: attachment.sha256,
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
        ...(input.attachments?.length ? { uploadAttempted: false } : {}),
        revision: 0,
        background: input.background ?? parent?.background ?? false,
      }
      this.jobs.push(job)
      this.save()
      this.log(
        `consult created id=${job.id} promptChars=${job.prompt.length} attachments=${job.attachments?.length ?? 0}`,
      )
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
  private async ensureAttachments(job: GptProJob, runToken?: number) {
    if (!job.attachments?.length) return
    const driver = this.driverFor(job)
    const staged = job.stagedAttachments ?? []
    if (staged.length !== job.attachments.length || !driver.uploadAttachments)
      throw new Error("Owned attachment staging or browser upload support is unavailable")
    const root = this.persistence.stagingRoot?.()
    if (!root) throw new Error("Owned attachment staging is unavailable")
    const files: Array<{ path: string; name: string; mime: string; sha256: string }> = []
    for (const attachment of job.attachments) {
      const copy = staged.find((item) => item.id === attachment.id)
      if (!copy || copy.uploadName !== attachment.uploadName || path.basename(copy.path) !== attachment.uploadName)
        throw new Error("Staged attachment metadata is incomplete")
      const relative = path.relative(path.join(root, job.id), copy.path)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Staged attachment path is outside its owned job directory")
      const info = await lstat(copy.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== attachment.size)
        throw new Error("Staged attachment changed before upload")
      const bytes = await readFile(copy.path)
      if (digest(bytes) !== copy.sha256 || copy.sha256 !== attachment.sha256.toLowerCase())
        throw new Error("Staged attachment digest changed before upload")
      this.log(
        `consult attachment pre-upload integrity job=${job.id} id=${attachment.id} bytes=${bytes.byteLength} verified=true`,
      )
      files.push({ path: copy.path, name: attachment.uploadName, mime: attachment.mime, sha256: copy.sha256 })
    }
    const mayDispatch =
      job.uploadAttempted === false &&
      job.attachments.every((attachment) => attachment.status === "pending" || attachment.status === "unknown")
    if (mayDispatch)
      this.update(job, {
        attachments: job.attachments.map((attachment) => ({ ...attachment, status: "uploading", error: undefined })),
      })
    try {
      await driver.uploadAttachments(
        files,
        mayDispatch,
        async () =>
          (this.controlling.has(job.id) && job.phase === "paused" && !!job.recovery) ||
          (await this.checkpoint(job, runToken)),
        async () => {
          const managedRecovery = this.controlling.has(job.id) && job.phase === "paused" && !!job.recovery
          if (!managedRecovery && !this.canDispatch(job, runToken))
            throw new Error("Attachment dispatch cancelled before file input; no upload was attempted")
          this.update(job, { uploadAttempted: true })
          this.log(`consult attachment dispatch boundary job=${job.id} count=${files.length} persisted=true`)
        },
      )
      const page = await driver.page()
      if (!this.bindPreviewEvidence(job, page))
        throw new Error("Composer attachment preview identity did not match this consultation")
      if (!this.hasExactAttachmentEvidence(job, page))
        throw new Error("Attachment upload returned without exact ready-card evidence")
      this.update(job, {
        attachments: job.attachments.map((attachment) => ({ ...attachment, status: "ready", error: undefined })),
      })
      this.log(`consult attachments verified job=${job.id} count=${files.length}`)
    } catch (error) {
      if (job.phase === "cancelled" || this.disposed) throw error
      const page = await driver.page().catch(() => undefined)
      if (page && job.uploadAttempted === true) this.bindPreviewEvidence(job, page)
      const observed = page && job.uploadAttempted === true ? this.observedAttachmentStatuses(job, page) : undefined
      this.update(job, {
        attachments:
          observed ??
          job.attachments.map((attachment) => ({
            ...attachment,
            status: job.uploadAttempted === true ? "unknown" : "pending",
            error: job.uploadAttempted === true ? "Attachment upload state could not be confirmed." : undefined,
          })),
      })
      const states = (observed ?? job.attachments).map((attachment) => attachment.status)
      this.log(`consult attachment upload paused job=${job.id} count=${files.length} states=${states.join(",")}`)
      throw error
    }
  }
  private observedAttachmentStatuses(job: GptProJob, page: GptProPageState) {
    const remaining = [...(page.attachments ?? [])]
    return (job.attachments ?? []).map((attachment) => {
      const key = attachmentIdentity(attachment)
      let index = remaining.findIndex((candidate) => attachmentIdentity(candidate) === key)
      if (index < 0) {
        const byName = remaining
          .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
          .filter(
            ({ candidate }) =>
              candidate.status === "failed" &&
              !!candidate.name &&
              (candidate.name === attachment.uploadName || candidate.name === attachment.name),
          )
        const expectedByName = (job.attachments ?? []).filter(
          (item) => item.uploadName === attachment.uploadName || item.name === attachment.name,
        )
        if (byName.length === 1 && expectedByName.length === 1) index = byName[0]!.candidateIndex
      }
      if (index < 0) {
        return { ...attachment, status: "unknown" as const, error: "Attachment state could not be confirmed." }
      }
      const [evidence] = remaining.splice(index, 1)
      if (evidence!.status === "ready") return { ...attachment, status: "ready" as const, error: undefined }
      if (evidence!.status === "failed") {
        return { ...attachment, status: "failed" as const, error: "ChatGPT reported an attachment upload error." }
      }
      return { ...attachment, status: "unknown" as const, error: "Attachment state could not be confirmed." }
    })
  }
  private bindPreviewEvidence(job: GptProJob, page: GptProPageState) {
    const expected = job.attachments ?? []
    const current = page.attachments ?? []
    if (current.length !== expected.length) return false
    const names = expected.map((attachment) => attachment.uploadName ?? attachment.name)
    if (new Set(names).size !== names.length) return false
    const used = new Set<number>()
    const bindings = new Map<string, string>()
    for (const attachment of expected) {
      const name = attachment.uploadName ?? attachment.name
      const matches = current
        .map((card, index) => ({ card, index }))
        .filter(({ card, index }) => !used.has(index) && card.name === name)
      if (matches.length !== 1) return false
      const { card, index } = matches[0]!
      used.add(index)
      if (card.status !== "ready") return false
      if (attachment.mime.startsWith("image/")) {
        if (card.kind !== "image" || !/^[a-f0-9]{64}$/i.test(card.sha256 ?? "")) return false
        if (attachment.previewSha256 && attachment.previewSha256.toLowerCase() !== card.sha256!.toLowerCase())
          return false
        bindings.set(attachment.id, card.sha256!.toLowerCase())
      } else if (card.kind === "image") {
        return false
      }
    }
    if (used.size !== current.length) return false
    const next = expected.map((attachment) => {
      const previewSha256 = bindings.get(attachment.id)
      return previewSha256 && !attachment.previewSha256 ? { ...attachment, previewSha256 } : attachment
    })
    if (next.some((attachment, index) => attachment !== expected[index])) {
      this.update(job, { attachments: next })
      this.log(`consult attachment preview identity bound id=${job.id} images=${bindings.size}`)
    }
    return true
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
      if (this.jobs.filter(isUnfinished).length >= 30)
        throw new Error("Too many queued consultations")
      const requestID = input.requestID ?? randomUUID()
      const parent = action === "intervene" ? this.get(input.id, owner) : undefined
      const jobOwner = parent?.owner ?? owner ?? "human"
      const createEpoch = this.ownerCancelEpoch.get(jobOwner) ?? 0
      if (parent) await this.syncURL(parent)
      if ((this.ownerCancelEpoch.get(jobOwner) ?? 0) !== createEpoch)
        throw new Error("owner_session_cancelled: consultation creation was revoked")
      if (input.background && !jobOwner.includes("\n"))
        throw new Error("Background consultations require a parent OpenCode session")
      const key = JSON.stringify([jobOwner, requestID])
      const pending = this.creating.get(key)
      if (pending) return this.publicJob(await pending)
      const duplicate = this.jobs.find((job) => job.requestID === requestID && job.owner === jobOwner)
      if (duplicate) return this.publicJob(this.get(duplicate.id, jobOwner))
      if (action === "consult") {
        const busy = this.ownerBusy(jobOwner)
        if (busy) throw new Error(`owner_page_busy: consultation ${busy.id} is still ${busy.phase}`)
      }
      const task = this.createConsultation(input, parent, jobOwner, requestID, owner, createEpoch)
      this.creating.set(key, task)
      try {
        return this.publicJob(await task)
      } finally {
        this.creating.delete(key)
      }
    }
    const job = this.get(input.id, owner)
    if (action === "send") {
      if (job.sendAttempted === true || job.submitted)
        throw new Error("A send was already attempted. Inspect and resume the original question; never resend.")
      this.requireRecovery(job, owner)
      this.controlling.add(job.id)
      try {
        await this.mutate(job, () => this.send(job, input.uid))
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
      const driver = this.driverFor(job)
      await this.mutate(job, () => this.openJobPage(job, driver, undefined, true), true)
      await driver.focus?.()
    }
    if (action === "pause") {
      if (!this.running.has(job.id) && job.phase !== "queued")
        throw new Error("Only a queued or running consultation can be paused")
      const keepCurrentPage = this.running.has(job.id)
      this.update(job, {
        phase: "paused",
        resumeCurrentPage: keepCurrentPage,
        queueReason: undefined,
        queueOwnerConsultationID: undefined,
      })
      this.interrupts.get(job.id)?.()
      const driver = this.driverFor(job)
      void this.mutate(job, () => this.openJobPage(job, driver, undefined, true))
        .then(() => driver.focus?.())
        .catch((error) => this.log(`consult pause reveal failed id=${job.id} error=${String(error)}`))
    }
    if (action === "stop") {
      if (job.phase === "completed" || job.phase === "cancelled") return this.publicJob(job)
      const driver = this.drivers.get(job.id)
      const page = this.lifecycle?.resources.list().find((page) => page.pageID === this.pageID(job))
      this.update(job, {
        phase: "cancelled",
        error: undefined,
        recovery: undefined,
        queueReason: undefined,
        queueOwnerConsultationID: undefined,
        notifications: job.notifications?.filter((event) => !event.recovery),
      })
      this.interrupts.get(job.id)?.()
      this.stopExistingPage(job, driver, "explicit-stop", page)
    }
    if (action === "resume") {
      if (job.phase === "send_uncertain" || (job.sendAttempted === true && !job.userID))
        throw new Error("Submission is uncertain. Inspect the original page manually; never resend this consultation.")
      if (!isUnfinished(job) && !(job.phase === "interrupted" && job.submitted && job.userID))
        throw new Error(`Cannot resume a ${job.phase} consultation`)
      const currentTask = this.running.get(job.id)
      if (currentTask) {
        if (job.phase !== "paused") throw new Error("Consultation is already running")
        await currentTask
      }
      const recovered = !!job.recovery
      const driver = this.driverFor(job)
      const pageAvailable = driver.hasPage?.() ?? true
      const resumeCurrentPage = pageAvailable && (recovered || job.resumeCurrentPage === true)
      if (!pageAvailable)
        this.log(
          `consult explicit resume reopening missing page id=${job.id} pageID=${job.pageID ?? `gpt-pro-page-${job.id}`} submitted=${job.submitted === true} sendAttempted=${job.sendAttempted === true}`,
        )
      if (resumeCurrentPage) driver.recover?.()
      if (!resumeCurrentPage) await this.syncURL(job, true)
      if (recovered) this.log(`consult agent recovery released id=${job.id}; no new consultation created`)
      this.update(job, {
        phase: "queued",
        error: undefined,
        recovery: undefined,
        queueReason: undefined,
        queueOwnerConsultationID: undefined,
        resumeCurrentPage,
      })
      void this.pump()
    }
    return this.publicJob(job)
  }
  private async pump() {
    if (this.pumping) {
      this.pumpRequested = true
      return
    }
    this.pumping = true
    this.pumpRequested = false
    try {
      const capacity = this.config().maxConcurrent ?? 4
      const pageCapacityBlocked = new Set<string>()
      while (!this.disposed && this.running.size < capacity) {
        let job: GptProJob | undefined
        for (const candidate of this.jobs) {
          if (
            candidate.phase !== "queued" ||
            this.pendingWork.has(candidate.id) ||
            this.activeOwners.has(candidate.owner) ||
            this.schedulerOwnerBlocker(candidate)
          )
            continue
          if (!(await this.reservePage(candidate))) {
            pageCapacityBlocked.add(candidate.id)
            this.log(`consult scheduler blocked id=${candidate.id} pageID=${this.pageID(candidate)} reason=page_capacity`)
            continue
          }
          if (
            this.disposed ||
            !this.jobs.includes(candidate) ||
            candidate.phase !== "queued" ||
            this.pendingWork.has(candidate.id) ||
            this.activeOwners.has(candidate.owner) ||
            this.schedulerOwnerBlocker(candidate)
          ) {
            this.releasePageReservation(candidate, "dispatch-eligibility-changed")
            this.log(`consult scheduler stale allocation skipped id=${candidate.id} phase=${candidate.phase} disposed=${this.disposed}`)
            continue
          }
          job = candidate
          break
        }
        if (!job) break
        this.activeOwners.add(job.owner)
        this.log(`consult scheduler dispatch id=${job.id} owner=${job.owner} running=${this.running.size + 1}/${capacity}`)
        const runToken = (this.runTokens.get(job.id) ?? 0) + 1
        this.runTokens.set(job.id, runToken)
        let interrupt!: () => void
        const interrupted = new Promise<void>((resolve) => {
          interrupt = resolve
        })
        this.interrupts.set(job.id, interrupt)
        const work = this.run(job, runToken)
        this.pendingWork.set(job.id, work)
        void work.catch(() => {})
        const task = Promise.race([work, interrupted])
          .catch((error) => this.failRun(job, error))
          .finally(() => {
            if (this.runTokens.get(job.id) === runToken) {
              this.running.delete(job.id)
              this.activeOwners.delete(job.owner)
              this.save()
              this.log(`consult scheduler release id=${job.id} phase=${job.phase} running=${this.running.size}`)
            }
            void work.finally(() => {
              if (this.pendingWork.get(job.id) === work) this.pendingWork.delete(job.id)
              this.save()
              if (this.runTokens.get(job.id) === runToken) this.releaseExecution(job, "runner-settled")
            }).catch(() => {})
            void this.pump()
          })
        this.running.set(job.id, task)
      }
      for (const job of this.jobs) {
        if (job.phase !== "queued" || this.running.has(job.id)) continue
        const ownerJob = this.schedulerOwnerBlocker(job)
        const queueReason = pageCapacityBlocked.has(job.id)
          ? "page_capacity"
          : ownerJob
            ? "owner_busy"
            : this.running.size >= capacity
              ? "capacity"
              : undefined
        const queueOwnerConsultationID = ownerJob?.id
        if (job.queueReason === queueReason && job.queueOwnerConsultationID === queueOwnerConsultationID) continue
        this.update(job, { queueReason, queueOwnerConsultationID })
      }
    } finally {
      this.pumping = false
      if (this.pumpRequested && !this.disposed) void this.pump()
    }
  }
  private failRun(job: GptProJob, error: unknown) {
    if (job.phase === "cancelled" || this.disposed) return
    const reason = error instanceof Error ? error.message : "Browser consultation failed"
    const attempted = job.sendAttempted === true || job.submitted
    this.log(`consult fixed flow handoff id=${job.id} stage=${this.stages.get(job.id) ?? "open"} attempted=${attempted} error=${reason}`)
    if (attempted && !job.userID) {
      this.update(job, {
        phase: "send_uncertain",
        error: `Submission was attempted but not confirmed: ${reason}. Never resend automatically.`,
        recovery: undefined,
        notificationPhase: undefined,
      })
      return
    }
    this.update(job, {
      phase: "paused",
      background: job.background || job.owner.includes("\n"),
      error: reason,
      notificationPhase: undefined,
      queueReason: undefined,
      queueOwnerConsultationID: undefined,
      recovery: {
        stage: this.stages.get(job.id) ?? "open",
        reason,
        needsHuman: error instanceof GptProPageError && error.kind === "verification",
      },
    })
  }
  private async run(job: GptProJob, runToken: number) {
    const driver = this.driverFor(job)
    const current = job.resumeCurrentPage === true
    this.update(job, { phase: "preparing", resumeCurrentPage: undefined, queueReason: undefined, queueOwnerConsultationID: undefined })
    this.stage(job, "open")
    if (!current)
      await this.mutate(job, () => this.openJobPage(job, driver, !job.parentID && !job.submitted))
    if (!(await this.checkpoint(job, runToken))) return
    this.stage(job, "ready")
    await this.mutate(job, () => driver.ready())
    if (!(await this.checkpoint(job, runToken))) return
    this.stage(job, "model")
    let page = job.submitted
      ? await this.inspectPage(job, driver)
      : await this.mutate(job, () => driver.observeModel())
    this.log(
      `consult model observation id=${job.id} label=${JSON.stringify(page.model || "unknown")} policy=user-selected nonblocking=true`,
    )
    if (!(await this.checkpoint(job, runToken))) return
    if (!job.submitted) {
      const parent = job.parentID ? this.jobs.find((item) => item.id === job.parentID) : undefined
      if (parent?.userID) {
        const limit = Date.now() + 30000
        while (!page.users.some((user) => user.id === parent.userID)) {
          if (Date.now() >= limit) throw new Error("Previous Chat context did not load. No follow-up was sent.")
          if (!(await this.checkpoint(job, runToken))) return
          await sleep(this.pollMs)
          page = await this.inspectPage(job, driver)
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
        await this.mutate(job, () => this.ensureAttachments(job, runToken))
        if (!(await this.checkpoint(job, runToken))) return
        page = await this.inspectPage(job, driver)
        const blockingError = this.blockingOwnedTurnError(page, undefined)
        if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)
        if (page.generating || (page.draft.trim() && (!current || page.draft.trim() !== job.prompt)))
          throw new Error("Composer changed during attachment upload. No prompt was submitted.")
      }
      if (!current || page.draft.trim() !== job.prompt) await this.mutate(job, () => driver.fill(job.prompt))
      if (!(await this.checkpoint(job, runToken))) return
      page = await this.inspectPage(job, driver)
      if (page.draft.trim() !== job.prompt || !this.hasExactAttachmentEvidence(job, page))
        throw new Error("Exact prompt and attachment evidence must be present immediately before sending")
      this.stage(job, "submit")
      const sendURL = page.url
      await this.mutate(job, () => driver.submit(async () => {
        if (!this.canDispatch(job, runToken))
          throw new Error("Consultation was paused or cancelled before the send boundary. Nothing was dispatched.")
        const current = await driver.page()
        const blockingError = this.blockingOwnedTurnError(current, undefined)
        if (
          blockingError ||
          current.url !== sendURL ||
          current.generating ||
          current.draft.trim() !== job.prompt ||
          current.users.length !== (job.userCount ?? 0) ||
          !this.hasExactAttachmentEvidence(job, current)
        )
          throw new Error("Composer or attachment evidence changed at the send boundary. Nothing was dispatched.")
        return () => {
          if (!this.canDispatch(job, runToken))
            throw new Error("Consultation was paused or cancelled before the send boundary. Nothing was dispatched.")
          this.update(job, { submitted: true, sendAttempted: true })
        }
      }))
    }
    this.stage(job, "track")
    let deadline = Date.now() + this.config().timeoutMinutes * 60000
    const submittedAt = Date.now()
    let stableAt = Date.now()
    let html = ""
    while (true) {
      if (this.disposed || ["cancelled", "failed", "interrupted", "send_uncertain"].includes(job.phase)) return
      if (job.phase === "paused") return
      if (this.controlling.has(job.id)) {
        await sleep(this.pollMs)
        continue
      }
      if (Date.now() >= deadline) {
        this.update(job, {
          phase: this.unconfirmedPhase(job),
          error: "Consultation timed out. The original page is preserved; stop or resume explicitly.",
        })
        if (!(await this.checkpoint(job, runToken))) return
        deadline = Date.now() + this.config().timeoutMinutes * 60000
      }
      page = await this.inspectPage(job, driver)
      if (!(await this.checkpoint(job, runToken))) return
      this.capturePendingURL(job, page)
      const errorUser = job.userID ? page.users.find((user) => user.id === job.userID) : page.users[job.userCount ?? 0]
      const blockingError = this.blockingOwnedTurnError(page, errorUser)
      if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)

      const expectedCount = (job.userCount ?? 0) + 1
      if (!job.userID) {
        const candidate = page.users[job.userCount ?? 0]
        if (candidate && candidate.text.trim() !== job.prompt) {
          this.update(job, {
            phase: this.unconfirmedPhase(job),
            error: "The submitted user turn does not match the managed prompt; no reply was accepted.",
          })
          continue
        }
        if (candidate && this.hasUnexpectedUserAttachments(job, candidate)) {
          this.update(job, {
            phase: this.unconfirmedPhase(job),
            error: "The submitted user turn has different attachments from the managed request.",
          })
          continue
        }
        if (candidate && !this.hasExactUserAttachmentEvidence(job, candidate)) {
          if (page.users.length > expectedCount || Date.now() - submittedAt > 30000) {
            this.update(job, {
              phase: this.unconfirmedPhase(job),
              error: "Submitted turn attachment evidence did not match. No reply was accepted.",
            })
            continue
          }
          await sleep(this.pollMs)
          continue
        }
        if (candidate) {
          this.update(job, { userID: candidate.id, url: page.url, model: job.model ?? page.model })
        } else {
          if (Date.now() - submittedAt > 30000)
            throw new Error("Submission could not be confirmed. Do not automatically resend.")
          await sleep(this.pollMs)
          continue
        }
      }

      const ownedIndex = page.users.findIndex((user) => user.id === job.userID)
      const user = ownedIndex < 0 ? undefined : page.users[ownedIndex]
      if (!user) {
        this.update(job, {
          phase: "paused",
          error: "The owned user turn is no longer present in the page history; no other reply was accepted.",
        })
        continue
      }
      if (user.text.trim() !== job.prompt || this.hasUnexpectedUserAttachments(job, user)) {
        this.update(job, {
          phase: "paused",
          error: "The owned user turn changed from the managed prompt or attachments; no reply was accepted.",
        })
        continue
      }
      if (!this.hasExactUserAttachmentEvidence(job, user)) {
        if (Date.now() - submittedAt > 30000) {
          this.update(job, {
            phase: "paused",
            error: "Submitted turn attachment evidence did not match. No reply was accepted.",
          })
          continue
        }
        await sleep(this.pollMs)
        continue
      }
      if (page.url !== job.url) this.update(job, { url: page.url })

      const laterUserExists = page.users.slice(ownedIndex + 1).length > 0
      const historyAnswer = page.answers?.find((item) => item.userID === user.id)
      const answer =
        historyAnswer ??
        (page.answer?.userID === user.id && !laterUserExists
          ? { ...page.answer, generating: page.generating }
          : undefined)
      const answerComplete = !!answer && answer.complete && !answer.truncated && answer.generating !== true

      // Once accepted, track only this userID. Later drafts or turns cannot
      // change its answer, and their global generation state is irrelevant.
      if (!job.userID) this.update(job, { userID: user.id, phase: "generating" })
      else if (job.phase === "preparing" || job.phase === "sending")
        this.update(job, { phase: "generating", error: undefined })
      if (answer) {
        if (answer.truncated) throw new Error("Reply exceeds HTML capture limit; incomplete output is not success.")
        if (html !== answer.html) {
          html = answer.html
          stableAt = Date.now()
          this.update(job, { text: answer.text, html, revision: job.revision + 1, url: page.url })
        }
        if (!answerComplete) stableAt = Date.now()
        if (answerComplete && Date.now() - stableAt >= this.stableMs) {
          this.update(job, { phase: "completed", error: undefined })
          return
        }
      }
      this.notify(job)
      await sleep(this.pollMs)
    }
  }
  private async checkpoint(job: GptProJob, runToken?: number) {
    return (
      !this.disposed &&
      !["paused", "cancelled", "send_uncertain"].includes(job.phase) &&
      (runToken === undefined || this.runTokens.get(job.id) === runToken)
    )
  }
  private blockingOwnedTurnError(page: GptProPageState, user: GptProPageState["users"][number] | undefined) {
    const error = page.error as
      | (NonNullable<GptProPageState["error"]> & { scope?: "turn" | "page"; userID?: string })
      | undefined
    if (!error) return undefined
    if (error.kind === "verification") return error
    if (error.scope === "page") return undefined
    if (error.scope === "turn") return user && error.userID === user.id ? error : undefined
    if (error.userID) return user && error.userID === user.id ? error : undefined
    // Older page states lack scope; only associate the error with the visible
    // latest user, never with an owned turn hidden by a later message.
    return !user || page.users.at(-1)?.id === user.id ? error : undefined
  }
  private stage(job: GptProJob, stage: GptProRecovery["stage"]) {
    this.stages.set(job.id, stage)
    this.log(`consult stage id=${job.id} stage=${stage}`)
  }
  private requireRecovery(job: GptProJob, owner?: string) {
    if (owner !== undefined && job.owner !== owner) throw new Error("Consultation belongs to another session")
    if (job.phase !== "paused" || !job.recovery)
      throw new Error("Browser interaction is available only for the active consultation's recovery handoff")
    if (this.controlling.has(job.id)) throw new Error("A browser control operation is already in progress")
  }
  private async requireReadable(job: GptProJob) {
    const driver = this.driverFor(job)
    if (this.running.has(job.id)) return
    const page = await this.inspectPage(job, driver)
    if (!job.submitted || !job.userID || page.users.some((user) => user.id === job.userID)) return
    throw new Error("The requested consultation does not own a readable browser page")
  }
  private async send(job: GptProJob, uid?: string) {
    const driver = this.driverFor(job)
    if (job.sendAttempted === true || job.submitted)
      throw new Error("A send was already attempted. Inspect and resume the original question; never resend.")
    let page = await driver.page()
    if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
    if (
      page.url !== job.url ||
      page.generating ||
      page.draft.trim() !== job.prompt ||
      page.users.length !== (job.userCount ?? 0)
    )
      throw new Error("Managed send requires the exact original prompt and unchanged conversation")
    await this.ensureAttachments(job)
    page = await driver.page()
    if (
      page.error ||
      page.url !== job.url ||
      page.generating ||
      page.draft.trim() !== job.prompt ||
      !this.hasExactAttachmentEvidence(job, page) ||
      page.users.length !== (job.userCount ?? 0)
    )
      throw new Error("Managed send requires the exact original prompt, attachments, and unchanged conversation")
    if (uid && !(await driver.element?.(uid))?.send)
      throw new Error("The observed element is not a send control; no question dispatched")
    this.update(job, { model: page.model, userCount: page.users.length })
    this.log(`consult managed recovery send id=${job.id} uid=${uid ?? "website-send-control"}`)
    await driver.submit(async () => {
      if (
        this.disposed ||
        !this.canDispatch(job)
      )
        throw new Error("Managed recovery was paused or cancelled before the send boundary. Nothing was dispatched.")
      const current = await driver.page()
      if (
        current.error ||
        current.url !== job.url ||
        current.generating ||
        current.draft.trim() !== job.prompt ||
        current.users.length !== (job.userCount ?? 0) ||
        !this.hasExactAttachmentEvidence(job, current)
      )
        throw new Error("Composer or attachment evidence changed at the send boundary. Nothing was dispatched.")
      return () => {
        if (
          this.disposed ||
          !this.canDispatch(job)
        )
          throw new Error("Managed recovery was paused or cancelled before the send boundary. Nothing was dispatched.")
        this.update(job, { submitted: true, sendAttempted: true })
      }
    }, uid)
    await this.syncURL(job, true, true)
    if (hasSendAttempt(job) && !job.userID && job.phase !== "cancelled")
      this.update(job, {
        phase: "send_uncertain",
        error: "The page did not confirm the submitted user turn. Inspect the original page; never resend.",
        recovery: undefined,
      })
  }
  async browserCommand(
    owner: string,
    id: string,
    name: GptProBrowserCommand,
    args: Record<string, unknown>,
    execute: (partition: string) => Promise<unknown>,
  ) {
    const job = this.get(id, owner)
    const driver = this.driverFor(job)
    const readOnly = ["state", "snapshot", "screenshot"].includes(name)
    if (readOnly) {
      while (!this.disposed && this.mutating.has(job.id)) await sleep(5)
      this.beginInspect(job.id)
      try {
        await this.requireReadable(job)
      } catch (error) {
        this.endInspect(job.id)
        throw error
      }
    } else {
      this.requireRecovery(job, owner)
      this.controlling.add(job.id)
    }
    this.log(`consult recovery browser id=${job.id} command=${name} owner=${JSON.stringify(owner)}`)
    try {
      if (!["state", "snapshot", "screenshot", "navigate", "click", "type", "scroll", "close"].includes(name))
        throw new Error("Unsupported consultation browser operation")
      if (!readOnly) {
        const current = await driver.page().catch(() => undefined)
        if (current?.error?.kind === "verification")
          throw new Error("Human browser verification is required; all agent browser mutations are blocked")
      }
      if (name === "navigate") {
        const url = String(args.url ?? "")
        if (!isGptProOrigin(url) || (job.submitted && url !== job.url))
          throw new Error("Recovery navigation must preserve the original ChatGPT conversation")
        const page = await driver.page().catch(() => undefined)
        if (
          page &&
          ((page.draft.trim() && page.draft.trim() !== job.prompt) ||
            (page.generating && page.users.at(-1)?.id !== job.userID))
        )
          throw new Error("Recovery navigation must preserve unrelated drafts and generation")
      }
      if (name === "click" || name === "type") {
        const page = await driver.page()
        if (page.error?.kind === "verification")
          throw new Error("Human browser verification is required; agent clicks and typing are blocked")
        if (job.submitted && page.url !== job.url)
          throw new Error("The original submitted conversation must be restored before interacting")
        const uid = String(args.uid ?? "")
        const element = await driver.element?.(uid)
        if (!element) throw new Error("Browser element inspection is unavailable")
        if (name === "click" && element.retry && (job.sendAttempted === true || job.submitted))
          throw new Error(
            "Retry/regenerate controls are blocked after a send attempt; the original question will not be repeated",
          )
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
          await this.mutate(job, () => this.send(job, uid))
          return { state: undefined, managedSend: true }
        }
      }
      const result = readOnly
        ? await execute(job.pageID ?? `gpt-pro-page-${job.id}`)
        : await this.mutate(job, () => execute(job.pageID ?? `gpt-pro-page-${job.id}`))
      await this.syncURL(job, job.phase === "paused")
      return name === "state" && result && typeof result === "object"
        ? { ...result, consultationCreatedAt: job.createdAt }
        : result
    } finally {
      if (!readOnly) this.controlling.delete(job.id)
      else this.endInspect(job.id)
      this.log(`consult recovery browser settled id=${job.id} command=${name}`)
    }
  }
  private async syncURL(job: GptProJob, allowPaused = false, alreadyMutating = false) {
    try {
      const page = alreadyMutating
        ? await this.driverFor(job).page()
        : await this.inspectPage(job, this.driverFor(job))
      if (this.disposed || job.phase === "cancelled" || (job.phase === "paused" && !allowPaused)) return
      this.capturePendingURL(job, page, allowPaused)
      const user = page.users.at(-1)
      if (
        !job.userID &&
        job.submitted &&
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
  private capturePendingURL(job: GptProJob, page: GptProPageState, allowPaused = false) {
    if (this.disposed || job.phase === "cancelled" || (job.phase === "paused" && !allowPaused)) return
    const user = page.users.at(-1)
    const submittedPromptVisible = page.users.length === (job.userCount ?? 0) + 1 && user?.text.trim() === job.prompt
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
