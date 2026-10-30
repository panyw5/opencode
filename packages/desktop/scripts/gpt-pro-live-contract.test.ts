import { expect, test } from "bun:test"
import {
  DEFAULT_GPT_PRO_CONFIG,
  GPT_PRO_PARTITION,
  type GptProJob,
  type GptProRuntimeStatus,
} from "@opencode-ai/util/gpt-pro"
import {
  assertGptProBoundSubmission,
  assertGptProLiveAnswer,
  gptProLiveOptions,
  requireGptProLiveProfile,
} from "./gpt-pro-live-contract"

test("live fixture options fail closed instead of silently sending a new consultation for legacy watch/project flags", () => {
  expect(gptProLiveOptions([])).toEqual({ rich: false, marker: undefined })
  expect(gptProLiveOptions(["--rich", "--marker", "OPENCODE_FIXTURE"])).toEqual({
    rich: true,
    marker: "OPENCODE_FIXTURE",
  })
  for (const args of [
    ["--watch"],
    ["--directory", "/user/project"],
    ["--parent", "ses_user"],
    ["--child", "ses_user"],
    ["--marker"],
    ["--marker", "PRIVATE PROMPT"],
    ["--rich", "--rich"],
  ])
    expect(() => gptProLiveOptions(args)).toThrow("not supported")
})

const runtime = (): GptProRuntimeStatus => ({
  config: { ...DEFAULT_GPT_PRO_CONFIG, enabled: true },
  login: { phase: "expired" },
  credentials: { phase: "available" },
  bridge: { connected: true },
  importBlocked: false,
  blockers: [],
  session: {
    profileID: `${GPT_PRO_PARTITION}-generation-fixture`,
    generation: 2,
    revision: 3,
    authentication: {
      phase: "authenticated",
      accountID: "synthetic-account",
      checkedAt: 1,
      source: { pageID: "login", epoch: 1, documentEpoch: 3, url: "https://chatgpt.com/", generation: 2 },
    },
    page: { phase: "interactive" },
    import: { phase: "verified" },
  },
})

test("live admission accepts verified generated profiles without Pro labels or a fresh local connection token", () => {
  expect(requireGptProLiveProfile(runtime())).toEqual({
    profileID: `${GPT_PRO_PARTITION}-generation-fixture`,
    generation: 2,
    accountID: "synthetic-account",
  })
})
test.each(["unverified", "verifying", "invalid", "verification", "transient"] as const)(
  "live admission cannot send from %s even with imported Cookies and a Pro label",
  (phase) => {
    const r = runtime()
    r.session.authentication.phase = phase
    r.session.page.model = "GPT-6 Pro"
    expect(() => requireGptProLiveProfile(r)).toThrow("verified development login")
  },
)
test.each(["unrestored", "restoring", "storage_fault"] as const)(
  "live admission rejects %s credential state",
  (phase) => {
    const r = runtime()
    r.credentials.phase = phase
    expect(() => requireGptProLiveProfile(r)).toThrow()
  },
)
test.each(["disabled", "bridge", "generation", "identity", "source", "candidate", "navigation"])(
  "live admission rejects %s before creating sidecar sessions",
  (change) => {
    const r = runtime()
    if (change === "disabled") r.config.enabled = false
    if (change === "bridge") r.bridge.connected = false
    if (change === "generation") r.session.generation++
    if (change === "identity") delete r.session.authentication.accountID
    if (change === "source") delete r.session.authentication.source
    if (change === "candidate") r.session.import.candidateProfileID = "pending"
    if (change === "navigation") r.session.page.phase = "navigation_error"
    expect(() => requireGptProLiveProfile(r)).toThrow()
  },
)
const completed = (): GptProJob => ({
  id: "gpt_synthetic",
  owner: "/tmp/fixture\nsession",
  requestID: "fixture",
  prompt: "Fixture",
  phase: "completed",
  url: "https://chatgpt.com/c/fixture",
  createdAt: 1,
  updatedAt: 2,
  revision: 1,
  submitted: true,
  sendAttempted: true,
  userID: "owned-user",
  profileID: `${GPT_PRO_PARTITION}-generation-fixture`,
  accountID: "synthetic-account",
})

test("completion validates immutable submission binding, not auth evidence from a replaced pre-send document", () => {
  const r = runtime()
  const binding = requireGptProLiveProfile(r)
  r.session.authentication = { phase: "unverified", checkedAt: 2 }
  expect(() => assertGptProBoundSubmission(completed(), binding)).not.toThrow()
})
test.each(["profileID", "accountID", "userID", "submitted", "sendAttempted"] as const)(
  "completion rejects changed or missing %s evidence",
  (key) => {
    const job = completed()
    if (key === "submitted" || key === "sendAttempted") job[key] = false
    else job[key] = ""
    expect(() => assertGptProBoundSubmission(job, requireGptProLiveProfile(runtime()))).toThrow("single-send evidence")
  },
)

test("live answer acceptance checks content rather than model labels or a completed phase alone", () => {
  expect(() => assertGptProLiveAnswer({ text: "MARKER", html: "<p>MARKER</p>" }, "MARKER")).not.toThrow()
  expect(() => assertGptProLiveAnswer({ text: "Unrelated", html: "<p>MARKER</p>" }, "MARKER")).toThrow("fixture answer")
  const rich = {
    text: "Explanation ".repeat(100) + "MARKER",
    html: "<table></table><pre><code>x</code></pre><math>x</math>",
  }
  expect(() => assertGptProLiveAnswer(rich, "MARKER", true)).not.toThrow()
  for (const tag of ["table", "code", "math"])
    expect(() => assertGptProLiveAnswer({ ...rich, html: rich.html.replaceAll(tag, "span") }, "MARKER", true)).toThrow(
      "Rich fixture",
    )
  expect(() => assertGptProLiveAnswer({ ...rich, text: "MARKER" }, "MARKER", true)).toThrow("Rich fixture")
})
