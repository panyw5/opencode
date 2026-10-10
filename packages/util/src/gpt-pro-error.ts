export const GPT_PRO_ISSUE_CODES = [
  "verification",
  "login",
  "login_import_busy",
  "login_import_pending",
  "login_expired",
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
export type GptProIssueContext = {
  error?: unknown
  code?: unknown
  phase?: string
  queueReason?: string
  needsHuman?: boolean
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
    if (/login_import_busy|stop.*consultation.*(?:replacing.*login|opening.*login)/.test(text)) return "login_import_busy"
    if (context.queueReason === "login_import") return "login_import_pending"
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
    if (context.needsHuman) return "verification"
    if (context.phase === "interrupted" || /application (?:stopped|restarted)|shutting down/.test(text))
      return "interrupted"
    if (text) return "unknown"
    if (context.phase === "paused") return "paused"
    return undefined
  })()
  if (!code) return
  return {
    code,
    tone: ["owner_busy", "page_capacity", "queue_capacity", "cancelled", "paused", "login_import_pending"].includes(code)
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
