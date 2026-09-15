# Channel-Only IM API Rework

## Rich Message Follow-Up (2026-09-15)

- [x] Optional text/markdown format in im_send, HTTP and regenerated SDK.
- [x] Feishu reuses task-card schema/Markdown rendering for a one-shot card;
  no status panels, automatic fallback or implicit duplicate sends.
- [x] Persist format; include it in live and retention-receipt idempotency while
  preserving historical plain-text fingerprints.
- [x] Text limit 4000, Feishu Markdown limit 12000; unsupported QQ Markdown and
  oversized input fail before provider requests.
- [x] 114 tests, zero failures, 476 assertions; backend/app/SDK typechecks passed.
- [x] Normal native Electron and shared DB (50 migrations): real cc marker
  IM_MARKDOWN_QA_1789409143827 sent as interactive with one attempt; retry reused
  provider ID, switching format under the same ID returned 409. Feishu client
  visibly rendered bold heading, list, code and link.

Feishu message.get returns a compatibility representation for Schema 2.0 cards,
not the original card body. Platform type was verified; actual body/rendering
was checked in the logged-in desktop client, not claimed from that fallback.
Changes not committed or pushed; installed application left running.

## Review Risk Follow-Up

- [x] Full allowed-users filtering for cached and discovered recipients.
- [x] Local text validation before requests; failed status with zero attempts.
- [x] Typed QQ provider rejection; uncertain errors remain unknown.
- [x] Renewing send leases and expired-only recovery; legacy untracked pending
  rows are not classified by age or presumed process restart.
- [x] Initial cleanup failure does not prevent later maintenance ticks.
- [x] Removed obsolete targets aggregator, TargetMetadata and AccessDeniedError.
- [x] QQ uses supplied durable provider sequences without updating fallback counters.
- [x] 113 focused backend tests passed, zero failures, 454 assertions; backend,
  app and SDK typechecks passed. Native environment acceptance recorded below.

Normal native acceptance (2026-09-15): 49 migrations loaded into development
Electron using original configuration/shared DB; lease column/index present.
Real cc marker `IM_RISK_QA_1789401668082` sent once and exact body verified through
Feishu API. Oversized API input returned failed with zero attempts, confirmed in
the database and backend validation log. Original model snapshot unchanged;
installed application not stopped.

## Agreed Delivery Boundary

Deliver configured-bot sending for ordinary projects now. Research automatic
user reply routing, channel takeover, unified timelines and project context
continuation later. Do not mistake existing explicit watches for automatic
reply ownership or shared project context.

## Contract

Ordinary projects call `im_send({channelName: "cc", text: "hello"})`. The
configured bot sends to its fixed private recipient. No caller-supplied chat
ID, platform, scope, project grant, or repeat binding for an existing known
private channel. Reading and watching also use channelName. Normal tool
confirmation and server authentication remain.

## Review

- REMOVE: public exact-target Access/Targets API, project read/send/watch
  switches, manual target form, ACL gates/joins in domain operations. These
  implemented the wrong business requirement. No implicit auto-grant patch.
- REWRITE: tools, HTTP schemas, SDK, UI and docs around configured channels.
- KEEP: internal provider Target types, runtime transports, durable inbox,
  monotonic cursors, project-scoped send idempotency, unknown-send handling,
  QQ sequences, subscription lifecycle/receipts, owning-session wakeup/recovery.
- KEEP AS HISTORY: applied migrations and old validation reports. Passing old
  infrastructure tests did not establish compliance with this contract.
- FIX: selected project reset on every mount; helper tests never covered
  selection persistence or a real user workflow.

## Plan

1. Inspect actual failing session/database; independently audit business and
   inbound paths, lock contracts and assign non-overlapping ownership.
2. Add durable shared fixed-recipient service. Reuse verified private inbox
   metadata and legacy desktop/CLI maps, verify Feishu legacy chat metadata.
   Handle missing/disabled/unsupported/ambiguous channels explicitly. Never
   choose arbitrary latest group/user or silently replace a sticky owner.
3. Remove business ACL dependencies from read/send/watch/retention. Preserve
   project idempotency, exact internal owner filtering and session ownership.
4. Implement channel-only HTTP/tools, deterministic tool send keys, clear
   errors and generated SDK. No public manual Access/Targets management.
5. Replace wrong UI with configured channel recipient/status and subscription
   management. Remember selected project using Electron-backed Persist.
6. Replace obsolete business tests; retain durable regression tests. Typecheck
   backend/app/SDK and test the actual UI through development CDP 9222.
7. Rebuild/restart only development Electron in normal user configuration and
   database. Coordinator verifies real cc channel-only send, platform/client
   receipt, channel-only watch, real private ingress, auto-wakeup and tool reply.
8. Record concrete evidence and limitations, finish documentation and cleanup.
   No commit/push or installed-app shutdown; do not leave fake config active.

## TODO

- [x] Independent business/API and inbound/UI review.
- [x] Actual failing session/database inspected before source edits.
- [x] Contracts, plan and worker ownership established.
- [x] Persistent owner service and automatic existing-cc discovery.
- [x] Owner observation before ingress early returns.
- [x] Runtime exact-target ACL dependencies removed.
- [x] Channel-only tools/HTTP/generated SDK.
- [x] Channel status/subscription UI and persistent project selection.
- [x] Corrected regression tests and typechecks.
- [x] Normal development Electron and CDP persistence validation.
- [x] Real cc channel-only send and provider/client verification.
- [x] Real watch -> private ingress -> project agent -> tool reply.
- [x] Final compatibility guard: old active group/non-owner watches must not
  newly admit messages after the ACL model is removed or recipient changes.
- [x] Final review, docs, limitations and cleanup.

## Ownership

- im_receive_review: owner/domain/channel integration/migration/domain tests.
- im_business_review: public API/tools/runtime wiring/SDK/tool tests/usage docs.
- Root: plan/UI/translations/CDP/normal-environment acceptance/final review.

## Final Result

108 backend focused tests passed, zero failures, 429 assertions across 18 files.
Five frontend tests passed. Backend, app and SDK typechecks passed. Latest Node
sidecar build contains 48 migrations; normal development Electron restarted,
16 connected providers loaded, three configured channel recipients remained
ready/running, and chat project selection survived renderer and process restart.

Real normal-environment cc verification: ordinary project Luna send, channel-only
watch -> real private ingress -> automatic wakeup -> tool reply, and direct HTTP
send with only channelName/text all passed. Three sent rows, one attempt each,
exact provider body checks, zero pending test session inputs. Test watch stopped
and test session archived; original configuration and installed app untouched.

The final review also fixed current-owner matching for legacy active group or
old-user subscriptions, preserving already-admitted recovery; HTTP watch list
and control are exact-directory scoped. Source ACL runtime and obsolete tests
were removed, historical schema/migrations retained to avoid breaking deployed
databases. No commit or push.

Detailed evidence and limitations:
[docs/im-channel-rework-verification.md](docs/im-channel-rework-verification.md).
