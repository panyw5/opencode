import { isGptProProfile, type GptProJob, type GptProRuntimeStatus } from "@opencode-ai/util/gpt-pro"

export type GptProLiveBinding = { profileID: string; generation: number; accountID: string }

export function gptProLiveOptions(args: string[]) {
  let rich = false
  let marker: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rich" && !rich) rich = true
    else if (args[i] === "--marker" && !marker && /^[A-Za-z0-9_-]{1,128}$/.test(args[i + 1] ?? "")) marker = args[++i]
    else
      throw Error(
        "Live GPT-Pro tests accept only --rich and --marker; existing project/session and replay flags are not supported",
      )
  }
  return { rich, marker }
}

/** Admission requires canonical evidence, never a model label or available encrypted Cookies alone. */
export function requireGptProLiveProfile(runtime: GptProRuntimeStatus): GptProLiveBinding {
  const { session, credentials } = runtime
  const auth = session.authentication
  if (!runtime.config.enabled) throw Error("GPT-Pro is disabled; no test settings were changed")
  if (!runtime.bridge.connected) throw Error("Development sidecar is unavailable; no consultation was created")
  if (
    credentials.phase !== "available" ||
    auth.phase !== "authenticated" ||
    !auth.accountID ||
    !auth.source ||
    auth.source.generation !== session.generation ||
    !isGptProProfile(session.profileID)
  )
    throw Error("A verified development login is required; no session or sidecar prompt was created")
  if (
    session.import.candidateProfileID ||
    session.import.phase === "installing" ||
    session.page.phase === "navigation_error"
  )
    throw Error("Development login is changing or its page is blocked; no consultation was created")
  return { profileID: session.profileID, generation: session.generation, accountID: auth.accountID }
}

/** Completion can outlive authentication evidence from the pre-send document. Ownership cannot change. */
export function assertGptProBoundSubmission(job: GptProJob, binding: GptProLiveBinding) {
  if (
    job.profileID !== binding.profileID ||
    job.accountID !== binding.accountID ||
    !job.submitted ||
    !job.sendAttempted ||
    !job.userID
  )
    throw Error("Consultation profile, account or single-send evidence changed; no replacement or resend is allowed")
}

export function assertGptProLiveAnswer(job: Pick<GptProJob, "text" | "html">, marker: string, rich = false) {
  if (!job.text?.includes(marker) || (!rich && job.text.trim() !== marker))
    throw Error("The generated fixture answer does not match its marker")
  if (
    rich &&
    (job.text.length < 1000 ||
      !job.html?.includes("<table") ||
      !job.html.includes("<code") ||
      !/<math|class="[^"]*katex/.test(job.html))
  )
    throw Error("Rich fixture output is missing its substantive text, table, code or rendered math")
}
