# WeChat ClawBot / iLink Channel Implementation

## Objective

Add a native WeChat channel to OpenCode using Tencent's official iLink protocol.
Reuse the existing channel runtime, durable IM inbox, owner discovery, project
subscriptions, agent tools, and automatic channel replies. Do not require an
OpenClaw installation or a reverse-engineered personal WeChat client.

The coordinator owns scheduling, integration, review, and end-to-end validation.
Implementation agents receive explicit file ownership after the protocol and
architecture contracts are agreed. Existing working-tree changes must be kept.
Do not push or run remote CI without a separate user request; any such operation
must target only panyw5/opencode.

## Status And Gates

- [x] User authorized implementation and automatic sub-agent scheduling.
- [x] Read repository and package instructions.
- [x] Record existing working-tree changes before implementation.
- [x] Confirm an existing development Electron renderer on CDP 9222.
- [x] Dispatch independent read-only protocol and architecture research agents.
- [x] Gate 1: agree protocol, security, persistence, and frontend/backend contracts.
- [x] Gate 2: backend transport and configuration pass focused tests.
- [x] Gate 3: project IM, automatic replies, API, SDK, and UI are integrated.
- [x] Gate 4: independent review and automated regression tests pass.
- [x] Gate 5: development Electron and mock sidecar scenarios are verified.
- [x] Record real WeChat authorization and delivery results separately from mocks.

## Phase 1: Protocol And Architecture

- [x] Pin primary-source references and record the official source revision.
- [x] Verify QR request method/body, application headers, and polling parameters.
- [x] Model wait, scanned, confirmed, expired, verification, and redirect states.
- [x] Define authorization attempt lifetime, cancellation, and retry semantics.
- [x] Verify authenticated request headers and observability metadata.
- [x] Define HTTPS host allowlisting and safe handling of provider redirects.
- [x] Verify inbound IDs, timestamps, item types, and bot-message filtering.
- [x] Verify long-poll timeout, cursor behavior, business errors, and backoff.
- [x] Determine what is established versus unknown about context-token expiry,
      proactive delivery, quotas, and simultaneous pollers.
- [x] Define account/user isolation and credential/context storage boundaries.
- [x] Review current IM markdown-format changes and preserve their semantics.
- [x] Agree API request/response schemas and agent file ownership.
- [x] Decide and document media support boundaries; do not silently discard media.

## Phase 2: Backend Foundation

- [x] Add a WeChat discriminated channel configuration schema.
- [x] Define account identity independently of rotating credentials.
- [x] Extend normalized platform/scope models without changing existing channels.
- [x] Add typed iLink request/response models and a testable API client.
- [x] Separate HTTP rejection, provider rejection, timeout, and malformed responses.
- [x] Apply bounded request timeouts and cancellation to all requests.
- [x] Implement QR authorization lifecycle on the authenticated backend.
- [x] Persist credentials securely; exclude them from status, logs, and errors.
- [x] Prevent credentials from being leaked through unsafe redirects or URLs.
- [x] Implement runtime start/stop and optional provider lifecycle notification.
- [x] Implement account ownership to prevent duplicate local pollers.
- [x] Implement cancelable long polling with bounded retries and stale-token state.
- [x] Persist messages before advancing the durable receive cursor.
- [x] Store reply context by account/user and restore it after restart.
- [x] Add structured, redacted logs for each lifecycle and delivery step.

## Phase 3: Channel And Project IM Integration

- [x] Normalize private text and available voice transcripts.
- [x] Enforce configured sender ACL; default binding to the authorized owner.
- [x] Register/unregister the WeChat transport through ChannelManager.
- [x] Discover and persist the fixed private recipient without manual chat IDs.
- [x] Reset/revalidate owner state when the bound account changes.
- [x] Deduplicate provider events and exclude outbound/bot echo events.
- [x] Route inbox events to project subscriptions and existing recovery logic.
- [x] Preserve subscription precedence over legacy automatic replies.
- [x] Implement automatic channel sessions and non-streaming final text replies.
- [x] Make im_list, im_read, im_send, and im_watch work with WeChat.
- [x] Resolve latest appropriate reply context without exposing tokens to agents.
- [x] Advertise proactive private delivery as limited until verified.
- [x] Explicitly reject unsupported group/guild operations.
- [x] Preserve pending/sent/failed/unknown semantics and stable send identifiers.
- [x] Preserve markdown/plain-text behavior and provider text-size validation.
- [x] Ensure retention policy does not accidentally delete required send state.
- [x] Generate a migration only if persistence schema changes require one.

## Phase 4: API, SDK, And Configuration UI

- [x] Add authenticated, workspace-aware login/status/cancel or equivalent APIs.
- [x] Keep frontend QR polling cancellable and ignore stale attempt responses.
- [x] Return useful connection/auth/recipient states, never raw credentials.
- [x] Regenerate SDK using the project generator; retain unrelated API changes.
- [x] Add WeChat navigation, counts, labels, and translated help text.
- [x] Add QR rendering, authorization progress, refresh, and verification entry.
- [x] Add connected-account status and explicit reconnect/rebind controls.
- [x] Support channel enable/disable, model, ACL, autoReply, and retention options.
- [x] Add connection testing that does not claim receipt before provider acceptance.
- [x] Integrate Project IM service channel readiness and watches.
- [x] Match the existing design and verify narrow and desktop layouts.

## Phase 5: Media

- [x] Assess inbound image/file/video handling against existing session attachments; defer encrypted media.
- [x] Validate provider CDN hosts, download sizes, timeout, and filenames.
- [x] Implement required AES decoding with fixtures if media is included (not applicable to the text-only release).
- [x] Preserve text/captions from mixed messages and document server-ID-only quote restoration as deferred.
- [x] Do not claim outbound media support through the text-only IM tools.
- [x] Document unsupported media explicitly if deferred after a working text release.

## Phase 6: Automated Tests And Independent Review

- [x] QR state transitions, verification, expiration, cancellation, and redirects.
- [x] Header construction, credential redaction, and unsafe-host rejection.
- [x] Long-poll timeout/backoff/cancellation and stale credentials.
- [x] Crash/restart cursor ordering and duplicate inbound events.
- [x] Account/user context isolation and context persistence.
- [x] ACL rejection, owner discovery, rebind, and changed-recipient behavior.
- [x] Private send success, explicit rejection, timeout, and unsupported targets.
- [x] Project read/watch wakeup, busy-session handling, and autoReply precedence.
- [x] Send idempotency, retention, and existing markdown regression coverage.
- [x] Frontend authorization state and stale-response tests.
- [x] HTTP auth/schema/error tests and SDK compatibility checks.
- [x] Run focused channel, IM, config, API, and UI tests from package directories.
- [x] Run affected package typechecks and distinguish pre-existing failures.
- [x] Assign independent read-only review; fix findings and rerun affected tests.

## Phase 7: Electron And Sidecar End-To-End Verification

- [x] Inspect existing development process and backend endpoints/logs ourselves.
- [x] Avoid altering user channels or interrupting active sessions during testing.
- [x] Use isolated fixtures/mock provider for deterministic full-path tests.
- [x] Test QR UI and login failure/retry via development Electron CDP 9222.
- [x] Test enable/disable/restart and connection-state display.
- [x] Send inbound messages ourselves through the test provider and verify storage.
- [x] Verify automatic replies and project-watch wakeup ourselves.
- [x] Send project IM messages ourselves and verify provider-received payloads.
- [x] Check backend logs at every step, with no token/body leakage.
- [x] Obtain real phone QR authorization when the implementation is ready.
- [x] Verify real inbound delivery and replies independently where accessible.
- [x] Verify proactive sends with fresh, older, absent, and invalid reply context.
- [x] Record actual outcomes and do not describe mock delivery as real delivery.
- [x] Clean up only test-owned data/processes and leave installed apps untouched.

## Completion

- [x] Publish configuration, operation, security, and troubleshooting documentation.
- [x] Update this checklist with test commands/results and residual limitations.
- [x] Confirm all modified/generated files preserve prior user changes.
- [x] Report implemented scope, verified scope, and any authorization blocker.
- [x] Mark the goal complete only after final review and final sidecar reload are verified.

## Primary Sources

- https://github.com/Tencent/openclaw-weixin
- https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
- https://docs.openclaw.ai/channels/wechat

## Coordinator Notes

Text/private-channel release is implemented. Phase 5 encrypted media is a
supported inbound capability; outbound media tools remain a separate follow-up.
Real platform delivery remains an acceptance item; do not mark the goal complete yet.

Verification recorded so far:

- Final combined backend suite: 123 passed, 0 failed, 672 assertions, 30 files.
- The network/LLM E2E uses a separate Bun process (as a real sidecar does) to
  avoid cross-test DI mock memoization. Parent verifies exit code, success
  marker, and child test result; child runs the complete HTTP/model/send path.
- Two isolated HTTP provider/LLM E2E/lifecycle tests passed, 23 assertions.
- Three QR state/timeout tests passed, 18 assertions.
- Eight app helper/config tests passed, 38 assertions.
- Backend/app/desktop typechecks and SDK generation/build passed.
- Development Node server and Electron bundles built successfully.
- Development sidecar reloaded after checking no active sessions; installed
  applications were not stopped.
- CDP verified WeChat navigation, channel creation, actual QR retrieval,
  cancellation, and awaiting-login runtime state. User channel wechat was created.
- Backend logs independently inspected; no WeChat account/context secrets in
  the reviewed authorization log events.
- Phone authorization requested. Actual WeChat inbound/outbound delivery,
  context aging, quotas, and cross-machine poller behavior remain unverified.
- Final CDP narrow-screen verification: viewport 390x844, scroll width 390,
  detail region height 403, complete 220px QR visible. Navigation panels now
  have bounded heights below the desktop breakpoint without changing desktop.
- Real QR wait, expiration, refresh, and cancellation were observed in backend
  logs; current authorization is waiting for the phone user to confirm.
- Additional hardening verifies stable provider client IDs, fail-closed exact
  reply context, disk-write replay, missing-context restart recovery, real 30s
  receive backoff, cross-process lock/crash recovery, HTTP same-account token
  refresh, concurrent channel binding, and timeout persistence as unknown.
- The desktop WeChat client is installed, running, and available for agent-led
  message delivery verification once phone authorization completes.
- Media E2E: encrypted PNG downloads once, persists as a safe BLOB/descriptor,
  survives subscription materialization, reaches the model and autoReply, and
  rejects SVG/untrusted URLs without leaking or blocking the receive cursor.
- Real WeChat: QR authorization completed; inbound private text `你好` was
  received, persisted, and returned by `/im/messages`; the automatic model run
  completed; after a full development-sidecar restart, a proactive send using
  the recovered context returned `sent` and logs recorded provider acceptance.
- Earlier sends made while an older sidecar chunk was loaded remain `unknown`
  and were not retried. The final explicit send completed once with a stable
  durable ID. Restart also exercised abandoned account-lock recovery without a
  duplicate inbound row.
- Final development build loaded 51 migrations, recovered the live account,
  returned `connected`, retained exactly one real inbound row, and ran the
  final media-capable code. The explicit real send returned `sent`; backend
  logs independently recorded `private send accepted` and completion.

Initial development renderer: http://localhost:5173/index.html, CDP 9222.
Initial working tree includes ongoing IM message-format changes across channel,
IM storage/service, HTTP API, tests, and generated SDK. These are not ours to
revert. Research agents are read-only until ownership/contracts are agreed.
