# Project Agent IM API

> Historical checklist for the rejected exact-target authorization model.
> Active plan: [IM_API_REWORK_TODO.md](IM_API_REWORK_TODO.md).

- [x] Step 1: Inspect channels, session inbox, permissions, API and test entry points.
- [x] Step 2: Implement transport abstraction and durable message infrastructure (unit/type checks passed; real platform verification pending).
- [x] Step 3: Project authorization, API, SDK and list/send/read tools implemented (38 focused tests passed; populated-database migration repair and independent 10-test foundation rerun passed; development sidecar verified registrations, denial, revocation and project-scoped IDs).
- [x] Step 4: Durable subscriptions, safe session wakeup, legacy ownership/CAS and paginated recovery implemented; independent dispatcher/migration verification passed.
- [x] Step 5: User-facing authorization/subscription management, scoped loading, localized states, channel reply/retention settings and serial rebased config writes; Electron CDP operations verified.
- [x] Step 6: Integration, development sidecar process restarts, Electron desktop/narrow checks, platform send verification and usage documentation completed.

## Execution

GPT-5.6-luna implements each bounded step. The coordinator reviews results and assigns the next step without waiting for user confirmation.
Preserve unrelated edits. Never push or run Actions outside panyw5/opencode.
Do not claim real Feishu/QQ delivery verification without actual send/receive evidence.

## Current Step 4 Progress

- [x] Subscription CRUD, exact matching, watch authorization, start sequence and durable delivery records.
- [x] Startup recovery entry points and explicit owner-session drain; bounded interruptible read waiting.
- [x] Real dispatcher/LLM integration verification (6 tests passed: full ingest/owner turn, overlap/replay, busy queue, out-of-order and stop/revoke; both ingest-before-admit and admit-before-drain recovery).
- [x] Legacy processing-state recovery and explicit auto-reply configuration.
- [x] Bounded background dispatch and cancellable failure retry.
- [x] Final review fixes: monotonic legacy state, subscription-owned replay routing, paginated recovery beyond 100 items, observable/retryable owner drain failures.

## Acceptance Checks

- [x] Default-deny access; no credential exposure; exact project/platform/channel/scope/chat isolation.
- [x] Revoked access blocks new reads, sends and subscription delivery.
- [x] Stable incremental checkpoints include later arrivals with identical timestamps.
- [x] Invalid cursors and mismatched reply targets produce documented errors.
- [x] Duplicate events do not duplicate inbox admissions or completed processing.
- [x] Project-scoped idempotency rejects changed payloads and never implicitly retries unknown sends.
- [x] Provider rejection is not reported as sent; stored content matches delivered content.
- [x] Existing databases with populated message tables upgrade successfully (fresh-install and historical-row migration tests passed).
- [x] Busy sessions queue delivery; restart recovers pending deliveries; stopping prevents future delivery.
- [x] Subscription matching does not produce implicit IM replies or bot loops.
- [x] Feishu/QQ send adapters tested with provider mocks and real platform sends; QQ mock Gateway exercised the actual receive handler and durable ingestion; Node sidecar exercised subscription/assistant recovery.
- [x] Development Electron management UI works over CDP 9222; project selection, grant, create, pause/resume/stop and confirmed revoke verified; narrow viewport has no horizontal overflow.
- [x] Usage documentation explains local-server trust and real platform restrictions.

## Platform Evidence

- [x] Feishu: authenticated project HTTP send returned sent with provider ID; platform message lookup verified exact marker text. Pure transport factory used; no Gateway started; temporary authorization removed.
- [x] QQ: authenticated project HTTP send accepted by platform HTTP 200 with provider message ID (C2C proactive); no Gateway started; temporary authorization removed. Other QQ scopes/quotas remain platform-specific.
- [x] Electron Node sidecar: offline ingestion followed by startup recovered exactly one assistant turn; repeat restart kept one turn and model request count at one.

## Final Verification

- [x] Backend focused matrix: 88 passed, zero failed (16 files), including intelligent-agent watch create/list/pause/resume/stop and own-session authorization tests.
- [x] Frontend helper/coordination tests: 5 passed, zero failed.
- [x] Repository type checks: 16 tasks succeeded.
- [x] Optional retention cleanup and hashed receipts; post-cleanup dedupe/idempotency/counter continuity verified; no automatic deletion without configured policy.
- [x] Daily maintenance startup/stop/restart and failure-continuation tests.
- [x] Supplemental mock QQ Gateway receive-path test.

## Delivery Notes

Development source and generated SDK are updated. No commit or push was made; the installed application was not replaced or shut down.
Real Feishu send/readback and QQ C2C proactive acceptance were verified. Other QQ scopes/quotas and live human-to-bot Gateway delivery were not exhaustively verified; mock Gateway and native session integration tests cover the receive/dispatch paths.

## Live End-to-End Follow-Up (2026-09-14)

- [x] Real Feishu desktop-client message -> configured live Gateway -> durable inbox -> ordinary-project GPT-5.6-luna -> im_read -> im_send reply -> desktop display and provider readback.
- [x] Agent created its own im_watch before receiving; exactly one successful send attempt and zero pending session inputs.
- [x] Corrected test instruction to use provider eventID for replyTo and clarified tool parameter/documentation; 11 focused regression tests passed.
- [x] Stopped test subscriptions/Gateway, revoked temporary authorization, and removed temporary credential-bearing configuration.

This verifies Feishu private chat through the source backend. It does not replace native Electron sidecar testing, nor claim QQ live inbound or shared-channel multi-instance reliability. See docs/im-e2e-verification.md for first-run failure and bounded retry details.
