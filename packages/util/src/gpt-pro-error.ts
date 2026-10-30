export const GPT_PRO_ISSUE_CODES = [
  "verification",
  "login",
  "login_import_busy",
  "login_import_pending",
  "login_invalid_session",
  "login_import_failed",
  "credential_storage",
  "result_storage",
  "account_changed",
  "login_expired",
  "login_connection_expired",
  "login_connection_failed",
  "browser_open_failed",
  "disabled",
  "owner_busy",
  "page_capacity",
  "queue_capacity",
  "send_uncertain",
  "timeout",
  "connection",
  "page_closed",
  "page_changed",
  "draft_protected",
  "attachment",
  "history_missing",
  "rate_limit",
  "request_rejected",
  "response_too_large",
  "control_unavailable",
  "interrupted",
  "cancelled",
  "paused",
  "stop_unconfirmed",
  "unknown",
] as const

export type GptProIssueCode = (typeof GPT_PRO_ISSUE_CODES)[number]
export type GptProHumanAction = "login" | "verification" | "secure_storage" | "restore_account"
export class GptProOperationError extends Error {
  constructor(
    readonly code: GptProIssueCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = "GptProOperationError"
  }
}
export type GptProIssueContext = {
  error?: unknown
  code?: unknown
  phase?: string
  queueReason?: string
  humanAction?: GptProHumanAction
}

export function gptProErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return ""
}

/** Keep raw diagnostics separate from user guidance; Electron wraps many legacy errors. */
export function gptProIssue(
  context: GptProIssueContext,
): { code: GptProIssueCode; tone: "info" | "warning" | "error" } | undefined {
  const text = gptProErrorText(context.error).toLowerCase()
  const code = (() => {
    // Never suggest retrying an unconfirmed submission, even if its cause is a network error.
    if (
      context.phase === "send_uncertain" ||
      /submission (?:is uncertain|could not be confirmed)|send was already attempted|submitted turn.*not confirm|submission was attempted but not confirmed/.test(
        text,
      )
    )
      return "send_uncertain"
    if (/website stop could not be confirmed/.test(text)) return "stop_unconfirmed"
    if (GPT_PRO_ISSUE_CODES.includes(context.code as GptProIssueCode)) return context.code as GptProIssueCode
    const explicit = /^([a-z_]+):/.exec(text)?.[1]
    if (GPT_PRO_ISSUE_CODES.includes(explicit as GptProIssueCode)) return explicit as GptProIssueCode
    if (/login_invalid_session/.test(text)) return "login_invalid_session"
    if (/login_import_failed/.test(text)) return "login_import_failed"
    if (/credential_storage/.test(text)) return "credential_storage"
    if (/account_changed/.test(text)) return "account_changed"
    if (/login_import_busy|stop.*consultation.*(?:replacing.*login|opening.*login)/.test(text))
      return "login_import_busy"
    if (context.queueReason === "login_import") return "login_import_pending"
    if (context.queueReason === "disabled") return "disabled"
    if (/browser_open_failed|could not open the default browser/.test(text)) return "browser_open_failed"
    if (/login_connection_failed/.test(text)) return "login_connection_failed"
    if (/verification|verify you|cloudflare|human.*challenge|验证/.test(text)) return "verification"
    if (/sign[ -]?in|log[ -]?in|needs_login|unauthenticated|\b401\b/.test(text)) return "login"
    if (/enable gpt-pro|gpt-pro.*disabled/.test(text)) return "disabled"
    if (
      /owner_page_busy|pause or stop the active consultation before opening another/.test(text) ||
      context.queueReason === "owner_busy"
    )
      return "owner_busy"
    if (/page_capacity/.test(text) || context.queueReason === "page_capacity") return "page_capacity"
    if (/too many queued consultations/.test(text) || context.queueReason === "capacity") return "queue_capacity"
    if (/\b429\b|rate.?limit|too many requests|usage limit/.test(text)) return "rate_limit"
    if (/\b403\b|rejected request|request.*reject/.test(text)) return "request_rejected"
    if (/consultation timed out|waiting.*timed out/.test(text)) return "timeout"
    if (
      /notconnected|not connected|no (?:desktop|browser) client|bridge.*(?:disconnect|unavailable)|failed to fetch|network|net::err_|socket|econn|could not refresh.*status|无法刷新咨询状态|command.*timed out/.test(
        text,
      )
    )
      return "connection"
    if (
      /consultation not found|stored.*(?:unavailable|missing)|saved result.*unavailable|结果.*(?:过期|不可用)/.test(
        text,
      )
    )
      return "history_missing"
    if (/manual draft|unrelated draft|browser is busy|reply is being generated/.test(text)) return "draft_protected"
    if (/attachment|file input|files? can be attached|file.*(?:size|digest|changed|format)|20 mib|50 mib/.test(text))
      return "attachment"
    if (/page.*clos|browser.*clos|view.*unavailable|browser view already/.test(text)) return "page_closed"
    if (
      /page generation changed|generation changed|unexpected origin|non-chatgpt|conversation.*(?:bound|changed)|user turn.*(?:changed|match|present)|no reply was accepted|exact prompt|evidence.*changed/.test(
        text,
      )
    )
      return "page_changed"
    if (/capture limit|reply exceeds|incomplete output/.test(text)) return "response_too_large"
    if (/composer|send control|snapshot|element|interface.*changed/.test(text)) return "control_unavailable"
    if (/owner_session_cancelled|consultation aborted|consultation was cancelled/.test(text)) return "cancelled"
    if (context.humanAction === "login") return "login"
    if (context.humanAction === "secure_storage") return "credential_storage"
    if (context.humanAction === "restore_account") return "account_changed"
    if (context.humanAction === "verification") return "verification"
    if (context.phase === "interrupted" || /application (?:stopped|restarted)|shutting down/.test(text))
      return "interrupted"
    if (text) return "unknown"
    if (context.phase === "paused") return "paused"
    return undefined
  })()
  if (!code) return
  return {
    code,
    tone: ["owner_busy", "page_capacity", "queue_capacity", "cancelled", "paused", "login_import_pending"].includes(
      code,
    )
      ? "info"
      : [
            "verification",
            "login",
            "send_uncertain",
            "draft_protected",
            "timeout",
            "interrupted",
            "rate_limit",
            "stop_unconfirmed",
          ].includes(code)
        ? "warning"
        : "error",
  }
}

export function gptProHumanAction(context: GptProIssueContext): GptProHumanAction | undefined {
  const code = gptProIssue(context)?.code
  if (["login", "login_expired", "login_invalid_session"].includes(code ?? "")) return "login"
  if (code === "verification") return "verification"
  if (code === "credential_storage") return "secure_storage"
  if (code === "account_changed") return "restore_account"
  return context.humanAction
}

/** One-time legacy history/outbox migration; no boolean human-verification inference on live paths. */
export function migrateGptProRecovery<T extends { stage: string; reason: string; humanAction?: GptProHumanAction }>(
  recovery: T | undefined,
  context: GptProIssueContext,
) {
  if (!recovery) return
  const action =
    gptProHumanAction({ ...context, humanAction: recovery.humanAction }) ??
    ((recovery as T & { needsHuman?: boolean }).needsHuman ? "verification" : undefined)
  return { stage: recovery.stage, reason: recovery.reason, ...(action ? { humanAction: action } : {}) }
}

/** The same recovery instruction is used by tool results and background notifications. */
export function gptProRecoveryInstruction(input: {
  id: string
  error?: string
  errorCode?: GptProIssueCode
  recovery?: { stage: string; humanAction?: GptProHumanAction; reason: string }
}) {
  if (!input.recovery) return ""
  const action = gptProHumanAction({
    error: input.error,
    code: input.errorCode,
    humanAction: input.recovery.humanAction,
  })
  const preserve = `Keep consultation_id=${input.id}. Do not create a new consultation or resend. Resume only this same ID explicitly after recovery; the program revalidates the account, managed prompt and attachments and controls any send. Preserve the user's current model selection.`
  if (action === "login")
    return `HUMAN LOGIN REQUIRED. Ask the user to reconnect ChatGPT through the approved login import and verification flow. Do not automate login or copy credentials. ${preserve}`
  if (action === "verification")
    return `HUMAN BROWSER VERIFICATION REQUIRED. Ask the user to complete the check in the owned page. Do not automate or bypass the challenge. ${preserve}`
  if (action === "secure_storage")
    return `HUMAN SECURE STORAGE RECOVERY REQUIRED. Ask the user to restore OS secure storage, then explicitly reconnect. Never use plaintext credentials. ${preserve}`
  if (action === "restore_account")
    return `ORIGINAL ACCOUNT REQUIRED. Ask the user to restore the original ChatGPT account. This consultation cannot send under another account. ${preserve}`
  if (input.errorCode === "result_storage")
    return `RESULT STORAGE RECOVERY REQUIRED. Preserve the original page and restore local result storage before explicitly resuming read-only tracking. ${preserve}`
  return `FIXED FLOW NEEDS AGENT RECOVERY at stage=${input.recovery.stage}. ${preserve} Use browser_read/browser_screenshot/browser_click/browser_type/browser_scroll/browser_navigate with consultation_id=${input.id} to inspect and repair only the owned page. Read the consultation for its managed prompt. After repair use gpt_pro_consult action=resume.`
}

export function gptProCanResume(
  context: GptProIssueContext & { sendAttempted?: boolean; submitted?: boolean; userID?: string },
) {
  if (gptProIssue(context)?.code === "send_uncertain") return false
  if ((context.sendAttempted || context.submitted) && !context.userID) return false
  return (
    context.phase === "paused" || (context.phase === "interrupted" && context.submitted === true && !!context.userID)
  )
}

export function gptProDiagnostic(error: unknown) {
  return gptProErrorText(error)
    .replace(/(?:Error:\s*)?Error invoking remote method ['"][^'"]+['"]:\s*/g, "")
    .replace(/^(?:Error:\s*)+/, "")
    .replace(/\n\s*at [^\n]+/g, "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(cookie|authorization)\s*[:=]\s*[^\n]+/gi, "$1=[redacted]")
    .replace(
      /\b(cookie|authorization|password|api[_-]?key|access[_-]?token|token)\s*[:=]\s*[^\n,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 2000)
}
