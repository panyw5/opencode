import type * as Lark from "@larksuiteoapi/node-sdk"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "channel.feishu.card" })

export type CardStep = {
  summary: string
  detail: string
}

export type MessagePartLike = {
  type?: string
  text?: string
  content?: string
  tool?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    error?: unknown
    title?: string
  }
}

export type MessageRowLike = {
  info?: { role?: string; id?: string; finish?: string }
  role?: string
  parts?: MessagePartLike[]
}

const DETAIL_LIMIT = 8000
const FINAL_LIMIT = 12000
const PATCH_MIN_INTERVAL_MS = 800

/** Schema 2.0 interactive card JSON (stringified for Feishu API). */
export function buildTaskCardJson(input: {
  status: string
  steps: CardStep[]
  final?: string | null
}): string {
  const elements: unknown[] = [{ tag: "markdown", content: `**${input.status}**` }]
  input.steps.forEach((step, idx) => {
    elements.push(stepPanel(idx + 1, step.summary, step.detail))
  })
  if (input.final) {
    elements.push({ tag: "hr" })
    elements.push({
      tag: "markdown",
      content: truncate(input.final, FINAL_LIMIT),
    })
  }
  return JSON.stringify({
    schema: "2.0",
    config: { streaming_mode: false, width_mode: "fill" },
    body: { elements },
  })
}

function stepPanel(idx: number, summary: string, detail: string) {
  const body = detail?.trim() ? truncate(detail, DETAIL_LIMIT) : "_(无输出)_"
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: `Turn ${idx} · ${summary.slice(0, 80)}`,
      },
    },
    elements: [{ tag: "markdown", content: body }],
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 24)}\n\n…(已截断,共 ${text.length} 字符)`
}

/** Best-effort extract message_id from Lark SDK create/reply responses. */
function extractFeishuMessageId(res: unknown): string | undefined {
  if (!res || typeof res !== "object") return undefined
  const r = res as {
    data?: { message_id?: string; data?: { message_id?: string } }
    message_id?: string
  }
  return r.data?.message_id || r.data?.data?.message_id || r.message_id
}

export function extractTextFromParts(parts: MessagePartLike[] | undefined): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && p.type === "text" && (typeof p.text === "string" || typeof p.content === "string"))
    .map((p) => (typeof p.text === "string" ? p.text : p.content) || "")
    .join("\n")
    .trim()
}

export function formatToolLines(parts: MessagePartLike[] | undefined): string[] {
  if (!Array.isArray(parts)) return []
  const lines: string[] = []
  for (const p of parts) {
    if (!p || p.type !== "tool" || !p.tool) continue
    const status = p.state?.status ?? "?"
    const input = p.state?.input
    let args = ""
    try {
      if (input != null) {
        const s = typeof input === "string" ? input : JSON.stringify(input)
        args = s.length > 200 ? `${s.slice(0, 200)}…` : s
      }
    } catch {
      args = ""
    }
    const title = p.state?.title ? ` — ${p.state.title}` : ""
    lines.push(`- \`${p.tool}\` (${status})${title}${args ? `\n  \`${args}\`` : ""}`)
  }
  return lines
}

/** Build one collapsible turn from a single assistant message. */
export function stepFromAssistant(row: MessageRowLike): CardStep | null {
  const parts = row.parts ?? []
  const text = extractTextFromParts(parts)
  const tools = formatToolLines(parts)
  const detailParts: string[] = []
  if (tools.length) detailParts.push(`### 🛠 Tool Calls\n${tools.join("\n")}`)
  if (text) detailParts.push(`### 📝 Output\n${text}`)
  if (detailParts.length === 0) {
    // Still show empty tool/reasoning-only steps lightly
    const hasActivity = parts.some((p) => p.type === "tool" || p.type === "reasoning" || p.type === "step-start")
    if (!hasActivity) return null
    detailParts.push("_(无文本输出)_")
  }

  let summary = ""
  if (tools.length) {
    const names = parts.filter((p) => p.type === "tool" && p.tool).map((p) => p.tool!)
    summary = names.length ? names.join(", ") : "工具调用"
  } else if (text) {
    summary = text.split("\n").find((l) => l.trim())?.trim() ?? "回复"
    summary = summary.replace(/^#+\s*/, "").slice(0, 60)
  } else {
    summary = "处理中"
  }

  return { summary, detail: detailParts.join("\n\n") }
}

/**
 * Assistant messages after the most recent user message → card steps.
 * Chronological order (Turn 1, 2, …).
 */
export function stepsFromMessages(rows: MessageRowLike[]): CardStep[] {
  let lastUser = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const role = rows[i].info?.role ?? rows[i].role
    if (role === "user") {
      lastUser = i
      break
    }
  }
  const steps: CardStep[] = []
  for (let i = lastUser + 1; i < rows.length; i++) {
    const role = rows[i].info?.role ?? rows[i].role
    if (role !== "assistant") continue
    const step = stepFromAssistant(rows[i])
    if (step) steps.push(step)
  }
  return steps
}

/** Join all assistant text after last user message (final answer body). */
export function finalTextFromMessages(rows: MessageRowLike[]): string {
  const chunks: string[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const role = rows[i].info?.role ?? rows[i].role
    if (role === "user") break
    if (role !== "assistant") continue
    const text = extractTextFromParts(rows[i].parts)
    if (text) chunks.push(text)
  }
  return chunks.reverse().join("\n\n").trim()
}

export type TaskCardOptions = {
  client: Lark.Client
  chatId: string
  /** Reply to this Feishu user message when possible. */
  replyTo?: string
}

/**
 * Feishu task card: one interactive message, repeatedly patched.
 * Each agent step becomes a collapsible panel; final answer sits below.
 */
export class FeishuTaskCard {
  private readonly client: Lark.Client
  private readonly chatId: string
  private readonly replyTo?: string
  private msgId: string | undefined
  private status = "🤔 思考中..."
  private steps: CardStep[] = []
  private final: string | null = null
  private lastPush = 0
  private startFallbackSent = false
  private finalFallbackSent = false
  private fingerprint = ""

  constructor(opts: TaskCardOptions) {
    this.client = opts.client
    this.chatId = opts.chatId
    this.replyTo = opts.replyTo
  }

  get messageId() {
    return this.msgId
  }

  private payload() {
    return buildTaskCardJson({
      status: this.status,
      steps: this.steps,
      final: this.final,
    })
  }

  private async sendInteractive(content: string): Promise<string | undefined> {
    try {
      if (this.replyTo) {
        const res = await this.client.im.message.reply({
          path: { message_id: this.replyTo },
          data: {
            content,
            msg_type: "interactive",
          },
        })
        const id = extractFeishuMessageId(res)
        if (id) return id
      }
      const res = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: this.chatId,
          content,
          msg_type: "interactive",
        },
      })
      return extractFeishuMessageId(res)
    } catch (err) {
      log.warn("feishu interactive send failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  private async patchInteractive(content: string): Promise<boolean> {
    if (!this.msgId) return false
    try {
      await this.client.im.message.patch({
        path: { message_id: this.msgId },
        data: { content },
      })
      return true
    } catch (err) {
      log.warn("feishu interactive patch failed", {
        messageId: this.msgId,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  private async fallbackText(text: string, final: boolean) {
    if (final) {
      if (this.finalFallbackSent) return
      this.finalFallbackSent = true
    } else {
      if (this.startFallbackSent) return
      this.startFallbackSent = true
    }
    const body = JSON.stringify({ text: text.slice(0, 4000) })
    try {
      if (this.replyTo) {
        await this.client.im.message.reply({
          path: { message_id: this.replyTo },
          data: { content: body, msg_type: "text" },
        })
        return
      }
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: this.chatId,
          content: body,
          msg_type: "text",
        },
      })
    } catch (err) {
      log.warn("feishu text fallback failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async push(force = false): Promise<boolean> {
    const content = this.payload()
    const fp = content
    if (!force && fp === this.fingerprint) return true
    const now = Date.now()
    if (!force && this.msgId && now - this.lastPush < PATCH_MIN_INTERVAL_MS) {
      return true
    }
    this.fingerprint = fp
    this.lastPush = now

    if (this.msgId) {
      return this.patchInteractive(content)
    }
    const id = await this.sendInteractive(content)
    if (id) {
      this.msgId = id
      return true
    }
    return false
  }

  async start(): Promise<void> {
    this.status = "🤔 思考中..."
    this.steps = []
    this.final = null
    const ok = await this.push(true)
    if (!ok) await this.fallbackText("🤔 思考中...", false)
  }

  /** Replace steps from latest session snapshot (idempotent). */
  async syncSteps(steps: CardStep[]): Promise<void> {
    this.steps = steps
    this.status = steps.length ? `⏳ 工作中 · Turn ${steps.length}` : "🤔 思考中..."
    await this.push(false)
  }

  async done(finalText: string): Promise<void> {
    this.status = "✅ 已完成"
    this.final = finalText?.trim() || "_(无文本输出)_"
    const ok = await this.push(true)
    if (!ok) await this.fallbackText(this.final, true)
  }

  async fail(message: string): Promise<void> {
    this.status = `❌ ${message}`
    const ok = await this.push(true)
    if (!ok) await this.fallbackText(`❌ ${message}`, true)
  }
}
