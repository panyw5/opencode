import type { GptProIssueCode } from "@opencode-ai/util/gpt-pro-error"

const messages = {
  login_import_busy: {
    en: ["Login import is blocked by an unfinished consultation", "You can open the connection page. Before importing another login, finish or stop consultations that are running or have already sent a question; changing accounts could break their reply tracking."],
    zh: ["已有咨询需要保留原账号登录", "连接页可以先打开。真正导入登录前，请结束正在运行或已发送问题的咨询，避免更换账号后无法继续读取原回复。"],
  },
  login_import_pending: {
    en: ["Waiting for login import", "The login is being updated. This queued consultation will continue automatically when the import finishes; do not submit it again."],
    zh: ["正在等待登录导入完成", "登录状态正在更新，导入结束后这条排队咨询会自动继续，不需要重新提交。"],
  },
  login_expired: {
    en: ["The connection page has expired", "Click Open connection page in default browser again, then finish importing within ten minutes. This is not a ChatGPT login failure."],
    zh: ["连接页面已过期", "重新点击“用默认浏览器打开连接页面”，并在 10 分钟内完成导入。这不代表 ChatGPT 账号登录失败。"],
  },
  login_connection_failed: {
    en: ["The local connection page could not start", "Try opening the connection page again. If it still fails, restart OpenCode after saving your work. No account login was changed."],
    zh: ["本地连接页面未能启动", "请重新点击打开连接页面。如果仍失败，保存工作后重启 OpenCode。账号登录没有被修改。"],
  },
  browser_open_failed: {
    en: ["The default browser could not be opened", "Check that your system has a working default browser, then click Open connection page again. This is not a ChatGPT login failure."],
    zh: ["未能打开默认浏览器", "检查系统默认浏览器是否能正常启动，再点击打开连接页面。这不是 ChatGPT 账号登录失败。"],
  },
  verification: {
    en: [
      "ChatGPT needs browser verification",
      "Open the original webpage and complete the verification yourself. Then continue this consultation; do not submit it again.",
    ],
    zh: ["ChatGPT 需要浏览器验证", "打开原网页，手动完成验证，再继续这条咨询。不要重新提交问题。"],
  },
  login: {
    en: [
      "ChatGPT login is required",
      "Check login on the original webpage. If needed, reconnect ChatGPT in Configuration > External agents > GPT-6 Pro, then continue the same consultation.",
    ],
    zh: [
      "需要登录 ChatGPT",
      "打开原网页检查登录状态。必要时到“配置页面 → 外部智能体 → GPT-6 Pro”重新连接 ChatGPT，再继续原咨询。",
    ],
  },
  disabled: {
    en: [
      "GPT-Pro is not enabled",
      "Enable GPT-6 Pro in Configuration > External agents and connect your ChatGPT login before starting a consultation.",
    ],
    zh: ["GPT-Pro 尚未启用", "到“配置页面 → 外部智能体 → GPT-6 Pro”启用服务并连接 ChatGPT 登录，再发起咨询。"],
  },
  owner_busy: {
    en: [
      "This session already has a consultation",
      "View the existing consultation in this session. Wait for it to finish or stop it before starting another.",
    ],
    zh: ["当前会话已有咨询", "先查看本会话的已有咨询，等待完成或停止它，再发起新咨询。"],
  },
  page_capacity: {
    en: [
      "All consultation page slots are occupied",
      "Close consultation pages you no longer need, or increase the resident page limit in configuration. Active consultations are not forcibly closed.",
    ],
    zh: ["咨询页面名额已满", "关闭不再需要的咨询页面，或在配置页提高常驻页面上限。运行中的咨询不会被强制关闭。"],
  },
  queue_capacity: {
    en: [
      "Consultation slots are temporarily full",
      "Queued consultations start automatically; do not submit duplicates. If this request failed to start, wait for a slot before starting it again.",
    ],
    zh: ["咨询名额暂时已满", "已排队的咨询会自动开始，无须重复提交。若本次启动失败，请等有空位后再发起。"],
  },
  send_uncertain: {
    en: [
      "We cannot confirm whether the question was sent",
      "Check for your question or reply on the original webpage. Do not resend or start a replacement consultation; automatic retry is disabled to prevent duplicates.",
    ],
    zh: [
      "暂时无法确认问题是否已发送",
      "打开原网页检查是否已有问题或回复。不要重发，也不要新建替代咨询；为避免重复发送，自动重试已禁用。",
    ],
  },
  timeout: {
    en: [
      "The consultation reached its waiting limit",
      "ChatGPT may still be replying. Check the original webpage, then continue tracking this consultation or stop waiting. Do not submit the question again.",
    ],
    zh: ["咨询已达到等待上限", "ChatGPT 可能仍在回复。查看原网页后，继续跟踪这条咨询或停止等待，不要重新提交问题。"],
  },
  connection: {
    en: [
      "The consultation connection is temporarily unavailable",
      "Check your connection and refresh the status. This does not mean the question failed to send; check the original webpage before taking further action.",
    ],
    zh: ["暂时无法连接咨询服务", "检查连接后刷新状态。这不代表问题没有发送；进行下一步前，请先检查原网页。"],
  },
  page_closed: {
    en: [
      "The consultation webpage was closed",
      "Open the original webpage, then continue this consultation if available. An already-sent question must not be sent again.",
    ],
    zh: ["咨询网页已关闭", "打开原网页，再按情况继续这条咨询。已经发送的问题不要再次发送。"],
  },
  page_changed: {
    en: [
      "The webpage no longer matches this consultation",
      "Check the original conversation and its question or attachments. Other replies will not be accepted; do not overwrite manual content or resend the question.",
    ],
    zh: [
      "网页内容与原咨询不一致",
      "检查原会话里的问题和附件。程序不会把其他回复当作结果；不要覆盖手动内容或重发问题。",
    ],
  },
  draft_protected: {
    en: [
      "Manual content on the webpage has been preserved",
      "Finish or preserve your draft, attachments, or ongoing reply on the webpage before continuing this consultation. Nothing was overwritten.",
    ],
    zh: [
      "网页上的手动内容已保留",
      "打开网页，先处理或保留草稿、附件和正在生成的回复，再继续原咨询。程序没有覆盖这些内容。",
    ],
  },
  attachment: {
    en: [
      "The attachment could not be confirmed",
      "Check format and size, then confirm the upload on the original webpage. Limits: 10 files, 20 MiB each, 50 MiB total. Do not resubmit a question already sent.",
    ],
    zh: [
      "附件暂时无法确认",
      "检查文件格式和大小，并在原网页确认上传状态。最多 10 个文件，单个 20 MiB、合计 50 MiB。已发送的问题不要重发。",
    ],
  },
  history_missing: {
    en: [
      "This saved record is unavailable",
      "The local record or copied attachment may have expired. Check the saved reply in the conversation or the original ChatGPT webpage; do not resend to view a record.",
    ],
    zh: [
      "这条本地记录暂时不可用",
      "本地记录或附件副本可能已过期。请查看会话里保存的回复或原 ChatGPT 网页；不要为了查看记录重新发送问题。",
    ],
  },
  rate_limit: {
    en: [
      "ChatGPT has temporarily limited requests",
      "Wait and check the limit shown on the original webpage. Do not repeatedly submit or create duplicate consultations.",
    ],
    zh: ["ChatGPT 暂时限制了请求", "稍后再处理，并查看原网页显示的额度限制。不要反复提交或创建重复咨询。"],
  },
  request_rejected: {
    en: [
      "ChatGPT did not accept this request",
      "Check login, verification, or account limits on the original webpage. Resolve the message shown there before continuing; do not blindly resubmit.",
    ],
    zh: ["ChatGPT 未接受这次请求", "打开原网页检查登录、验证或额度提示，解决网页上的问题后再继续，不要盲目重发。"],
  },
  response_too_large: {
    en: [
      "The reply is too large to capture completely",
      "Read the full reply on the original webpage. Partial saved text is not a complete result, and the question does not need to be sent again.",
    ],
    zh: ["回复过长，无法完整保存", "请到原网页阅读完整回复。已保存的部分内容不是完整结果，也不需要重新发送问题。"],
  },
  control_unavailable: {
    en: [
      "The webpage controls are not ready",
      "Wait for the original webpage to load or dismiss any dialog, then continue this consultation. Check whether the question was sent first.",
    ],
    zh: ["网页控件尚未就绪", "打开原网页，等待加载完成或关闭遮挡弹窗，再继续这条咨询。继续前先确认问题是否已发送。"],
  },
  interrupted: {
    en: [
      "Consultation tracking was interrupted",
      "Check progress on the original webpage and continue the same consultation if available. Do not start a duplicate after a restart.",
    ],
    zh: ["咨询跟踪已中断", "打开原网页检查进展，再按情况继续同一条咨询。重启后不要新建重复咨询。"],
  },
  cancelled: {
    en: [
      "The consultation was stopped",
      "No further steps will be sent by this consultation. Any existing webpage reply or saved result can still be viewed.",
    ],
    zh: ["咨询已停止", "这条咨询不会再发送后续步骤；网页上已有的回复和已保存结果仍可查看。"],
  },
  stop_unconfirmed: {
    en: [
      "The webpage reply has not been confirmed stopped",
      "This consultation is stopped locally and will send no further steps. The webpage may still be generating; check the original webpage and use its stop button if needed.",
    ],
    zh: [
      "尚未确认网页回复已停止",
      "这条咨询已在本地停止，不会继续发送。网页可能仍在生成；请打开原网页确认，必要时点击网页上的停止按钮。",
    ],
  },
  paused: {
    en: [
      "The consultation is paused",
      "Check the original webpage, then choose Continue consultation to handle the same question. Do not start it again.",
    ],
    zh: ["咨询已暂停", "检查原网页后点击“继续咨询”，继续处理同一个问题，不要重新发起。"],
  },
  unknown: {
    en: [
      "The consultation needs attention",
      "Check the original webpage before continuing. If the problem persists, expand the diagnostic details. Do not resubmit while the send status is unclear.",
    ],
    zh: ["咨询需要处理", "先检查原网页，再决定是否继续。问题持续时可展开诊断详情；发送状态不明确时不要重新提交。"],
  },
} satisfies Record<GptProIssueCode, { en: [string, string]; zh: [string, string] }>

const dictionary = (language: "en" | "zh") =>
  Object.fromEntries(
    Object.entries(messages).flatMap(([code, value]) => [
      [`ui.tool.gptPro.error.${code}.title`, value[language][0]],
      [`ui.tool.gptPro.error.${code}.hint`, value[language][1]],
    ]),
  )
export const gptProErrorEnglish = dictionary("en")
export const gptProErrorChinese = dictionary("zh")
