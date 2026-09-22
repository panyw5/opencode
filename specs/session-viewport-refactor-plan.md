# Session viewport ownership replacement

## Status and execution

- Requested and implemented on 2026-09-22. Phases 0-6 are complete within the verification
  coverage recorded below. Earlier execution-log checkpoints are historical, not final status.
- Parent agent owns the plan, interface decisions, integration review, and acceptance.
- Implementation and QA are delegated to gpt-5.6-luna workers in bounded stages.
- State-model implementation precedes integration. Shared core files have one writer.
- Each stage reports changed files, removed mechanisms, executed checks, and remaining risks.
- No commits, pushes, or remote actions are required. Any later push/action must use panyw5/opencode only.
- Preserve existing edits. Baseline scroll edits are session.tsx and use-session-scroll-utils.ts/test.ts.
- Ignore unrelated dirty files. Stop if a concurrent edit conflicts with the owned implementation.

## Required behavior

1. Native wheel/trackpad return to the bottom resumes following while idle or working.
2. Following persists through subsequent output, tool waits, completion, and late Markdown measurement.
3. Downward input at the physical bottom, including zero displacement, cannot detach following.
4. A temporary gap caused by content growth does not imply user detachment.
5. Upward outer-viewport input takes over immediately; later output cannot undo it.
6. Bottom alignment finishes without requiring another token, resize, or gesture-expiry timer.
7. Message/anchor/find targets retain ownership through measurements until explicit takeover.
8. History loads preserve current reading motion and never restore an obsolete positioning intent.
9. Ordinary send requests following once. Send-and-keep-view explicitly requests reading, even without overflow.
10. Submit completion and generated scroll events cannot issue another ownership request.
11. A passive layout change reaching the bottom does not turn reading into following.
12. Session/root replacement invalidates all old positioning callbacks.
13. Nested scrolling takes over only when input reaches the outer viewport boundary.
14. The Jump to latest action stays hidden throughout following, including temporary gaps
    during smooth streaming catch-up. It is available when overflow exists and the intent
    is not following. Physical bottom remains a separate geometric observation.

## Architecture limits

- Evolve createMessageNavigation; do not add a second viewport ownership controller.
- One authoritative positioning intent: following, reading, or target (message/anchor/find).
- Derived selectors cannot be independently writable. No effect synchronizes owner copies.
- Generation, request progress, geometry, and measurement metadata are not extra owners.
- Reuse existing session/generation tokens and root identity; do not build a generic lease framework.
- Timeline owns physical positioning. Page submits intent/data, not scrollTop writes.
- One application write outlet accepts concrete requested positions, not arbitrary callbacks.
- The outlet validates current intent/session/root, clamps against committed geometry, and records actual motion.
- Scroll origin labels describe motion; they are not sufficient authorization by themselves.
- No fallback direct writes when the runtime is unavailable; reconcile when the root mounts.
- A single bottom animation may execute following. It cannot decide or persist ownership.
- Avoid virtualizer.scrollToOffset/scrollToIndex/scrollToEnd in the main timeline: these create
  their own asynchronous reconciliation state. Compute goals from virtual geometry instead,
  disable library auto-compensation, and feed applied offsets into its observation adapter.
- Main-timeline wheel/touch uses native motion. Remove custom wheel easing/hardware guessing there.
- Controlled ScrollView keyboard/thumb movement passes through the timeline outlet. Other consumers retain defaults.
- Do not add an event bus, another scheduler framework, per-content following rules, or a new global context.
- Do not change public shared auto-scroll behavior for other consumers.

## Phase 0: Baseline and failing scenarios

Owner: viewport_luna (state/test inventory), viewport_qa_luna (environment), parent (baseline/spec).

Work:
- Read scoped AGENTS.md instructions and existing viewport coordination invariants.
- Record the current dirty baseline and identify the Electron build/worktree before runtime verification.
- Inventory all reachable main-viewport writers, including ScrollView and virtualizer callbacks.
- Run focused existing state, geometry, navigation, ledger, and follow tests.
- Identify existing failures without attributing them to this refactor.
- Prepare regression cases for natural return, zero-motion downward input, idle return,
  short-session keep-view, submit callback ordering, stale history, and root/session replacement.
- Inspect renderer AND backend logs directly. Never ask the user to perform QA.

Gate:
- Written minimal state/execution API agreed before worker integration edits.
- Test results distinguish code failures from missing dependencies/environment.
- CDP and sidecar test setup identified, or a concrete blocker documented.

## Phase 1: Authoritative intent model

Owner: viewport_luna. Scope: message-navigation.ts and focused model tests first.

Work:
- Make the existing navigation model the only holder of positioning intent and generation.
- Preserve hash acknowledgement/superseded-hash rules and shared-load completion semantics.
- Add explicit input/return-to-tail transitions without consulting generation status or userScrolled.
- Repeated following/reading input is idempotent; target replacement still invalidates old work.
- Keep a real keep-view request distinct from scroll observation and send completion.
- Define selectors for message target, full target, following, and reading from one snapshot.
- Add bounded string diagnostics at transition boundaries, not per-row console object dumps.

Gate:
- Pure tests cover idle and busy with identical ownership results.
- Content growth, generated scroll events, and gesture expiry cannot revoke following.
- Existing rapid-navigation and shared-load/hash tests still pass.
- No new model runs in parallel with the old one in production.

## Phase 2: Single position application contract

Owner: assigned Luna worker after Phase 1 API review; core integration has one writer.
Scope: scroll-ledger/runtime types, ScrollView optional controlled input, geometry helpers/tests.

Work:
- Replace arbitrary write callbacks with concrete applied-position operations and actual-motion results.
- Validate captured intent token and root/session lifetime before applying asynchronous positions.
- Keep ledger math independent of DOM ownership and preserve user/system displacement accounting.
- Add optional controlled keyboard/thumb positioning to ScrollView, retaining unrelated callers' defaults.
- Make anchor geometry computable without writing DOM; retain necessary top/reading semantics.
- Explicitly separate requested correction from browser-applied correction.
- Prepare virtualizer adaptation so automatic adjustment and manual anchor correction cannot both compensate.

Gate:
- Rejected stale writes do not invoke DOM writes or mutate ledger totals.
- Clamping/coalesced motion tests pass, including user reversal.
- Shared ScrollView default tests remain unchanged in behavior.

## Phase 3: Atomic production cutover and deletion

Owner: viewport_luna. Scope: session.tsx, use-session-hash-scroll.ts, message-timeline.tsx,
session-find.ts, live-bottom.ts, and their directly affected tests.

Work:
- Inject/read the sole model rather than creating another owner inside hash or timeline adapters.
- Remove independent viewportIntent/viewportTarget/navigationTarget copies and page mode setters.
- Remove main-session createAutoScroll, ui.mode, followBottom, and their reactive feedback effects.
- Remove duplicate pin predicates, scrollResumeIntent, and standalone timeline owner priority.
- Remove custom smooth-wheel state/loop; native wheel/touch input stays observable.
- Remove generation-status-driven following restoration and blanket gesture-active tail veto.
- Derive Jump to latest visibility from canonical intent plus overflow, not physical gap.
  Pass the composer a read-only presentation boolean; do not import the navigation model
  into the composer or add a visibility latch, timer, debounce, or hysteresis state.
- Page submits initial/send/keep-view/latest/navigation requests; timeline performs positioning.
- Dock/content/root resize invalidates geometry only; it cannot restore captured scrollTop independently.
- onSubmit selects intent once. onSubmitted only requests geometry reconciliation under current intent.
- Hash acknowledgement cannot revive following, and settled target behavior is preserved.
- Find produces positioning geometry/requests rather than bypassing the main write outlet.
- All target/follow callbacks carry original lifetime validation; cleanup cancels outstanding work.

Mandatory removal checklist:
- [x] Main-session autoScroll and userScrolled effect.
- [x] ui.mode, followBottom, arm/clear follow synchronizers.
- [x] Independently writable viewport intent/target selector copies.
- [x] Local timelineScrollOwner priority arbitration.
- [x] scrollResumeIntent and gesture-expiry ownership recovery.
- [x] Main-timeline smoothWheelTarget and custom wheel easing.
- [x] Page direct bottom/clamp/dock writes and fallback callback execution.
- [x] Second unconditional resume in onSubmitted.
- [x] Jump to latest visibility inferred from transient physical bottom distance.

Gate:
- Main session has one positioning intent and one application DOM write outlet.
- Source search plus review confirms no competing production path remains.
- App/UI type checks and focused tests pass. Intermediate code is not advertised as a fixed app.

## Phase 4: History and measurement correctness

Owner: Luna worker assigned after core cutover. Avoid simultaneous edits to message-timeline.tsx.

Work:
- Remove independent multi-frame prepend restore/pin loops and page anchor capture/restore callbacks.
- History request completion follows data commit, not scroll-animation completion.
- Reconcile prepend as a geometry change under the current intent and current reading anchor.
- Preserve user displacement during history waits and layout commits.
- Keep request deduplication and stale-session guards; do not discard valid shared data due to takeover.
- Deferred measurements use stable keys and valid content/width metadata, not stale numeric indexes.
- Remove old deferred anchors that can overwrite the latest reading anchor after continued input.
- Compute top/reading residual compensation together, then apply once per committed layout transaction.
- Verify parts projection invalidation, intentional collapse, estimate width/spacing, and cache provenance.
- Fix demonstrated correctness defects without adding content-specific ownership rules.
- Broader performance work (new grouping/windowing/parser frameworks) is out of scope unless essential to a failing case.

Gate:
- Prepend after user movement preserves the visible anchor and user delta.
- Switching to following/target during a request permits data merge but forbids old reading restore.
- Queued measurements cannot resize or cache the wrong row after prepend/removal.
- Collapse and width/content changes do not retain falsely certified heights.

## Phase 5: Composed automated verification

Owner: viewport_qa_luna, with implementation changes sent back to the owning worker.

Work:
- Test the actual composed state, Solid effects, timeline/execution, and virtualizer adapter,
  rather than only a standalone ownership reducer or a source-text assertion.
- Use controlled clocks/RAF and reorder input, measurement, history completion, and submit callbacks.
- Test sustained following through multiple geometry changes, not a single atBottom assertion.
- Check current target remains anchored after delayed measurements and find close/query replacement.
- Verify stale writes are rejected without interfering with current virtualizer offset synchronization.
- Run focused unit/browser suites and app/UI type checks; report baseline unrelated failures separately.
- Check no unbounded logs, per-row forced layout, or new cross-module feedback loops were introduced.

Gate:
- Every required behavior has a named regression test or a documented runtime scenario.
- Production deletion checklist complete; tests do not preserve old incorrect behavior.

## Phase 6: Development Electron and real sidecar acceptance

Owner: viewport_qa_luna; parent independently reviews evidence and checks integration.

Safety/setup:
- Check for a running development Electron before launching. Verify CDP 9222 belongs to the tested worktree.
- Never stop the installed application. Do not terminate an unidentified process.
- Read effective persisted keybind overrides before dispatching any shortcut.
- Use a dedicated test session, not a user's historical conversation. Send and verify messages ourselves.
- Read backend and renderer logs directly, without exposing credentials or unrelated conversation content.

Scenarios:
1. Wheel away then naturally return while idle; subsequent generation continues following.
2. Fractional high-frequency trackpad-like wheel input reaches bottom during real streaming.
3. Continue observing through later output bursts, pauses, tool/status transitions, and final Markdown resize.
4. Continue downward input at physical bottom with zero actual movement; following persists.
5. Reverse upward mid-follow; subsequent output does not steal the reading view.
6. Return near bottom then stop input and output; final alignment still completes.
7. Keep-view send in both overflowing and short non-overflowing conversations.
8. Submit then immediately scroll up before delayed submit completion.
9. History loading plus continued user motion; navigate/change session before an old completion.
10. Resize dock/panel, expand/collapse content, and revisit with a different width.
11. Observe the actual Jump to latest DOM action through up/down return, subsequent growth,
    pauses, and idle: following must never show it; real departure reveals it. Log intent,
    physical gap, and button visibility together so an ownership defect is not hidden by UI.

Evidence:
- Record build/worktree identity, input trajectory, relevant transition/write trace, and measured final geometry.
- Record actual received sidecar text/tool completion and corresponding backend status.
- Natural-return acceptance must not click Jump to latest or set scrollTop to simulate the decisive user input.
- CDP input is a browser-level simulation, not a claim of physical hardware testing.
- A final gap of zero or one isolated following frame is insufficient; verify later content changes too.
- If environment/API/model access blocks runtime verification, mark it blocked and do not claim completion.

## Final acceptance

- [x] Sole writable browsing intent; no mirrored owner synchronization.
- [x] Sole application main-viewport position outlet with stale callback/root protection.
- [x] Generation state never determines browsing ownership.
- [x] History fetching never owns an independent positioning loop.
- [x] Measurements never carry obsolete browsing commands.
- [x] Native user input and applied programmatic motion remain distinguishable.
- [x] Named regression tests, type checks, and real Electron/sidecar evidence reviewed.
- [x] Existing unrelated edits preserved; no commit/push without request.

## Final verification and limits

- App and UI type checks passed. Browser-condition suite: 31 passed, 0 failed,
  106 assertions. Focused shared ScrollView/auto-scroll checks: 11 passed.
- Final session suite: 388 passed, 1 failed, 821 assertions across 41 files.
  The failure is the pre-existing session-render-state.test.ts:80 object-identity assertion,
  "uses a wall-clock deadline only after content exists". Neither that source nor its test
  was changed. The full session suite is NOT claimed green.
- Final canonical text evidence:
  /private/tmp/opencode-viewport-qa/text-canonical-final-20260922.json.
  151 post-return growth commits, 4,553 RAF samples, 2,074 growth frames.
- Final canonical tool evidence:
  /private/tmp/opencode-viewport-qa/tool-canonical-final-20260922.json.
  147 post-return growth commits, 6,326 RAF samples, 1,944 growth frames.
  Two real safe shell calls completed; both five-line tool marker sequences and the final
  assistant receipt were verified against the tested user turn's parentID chain.
- Both final artifacts report acceptance pass with no failed assertions and clean input
  provenance. Across 10,879 RAF samples, identity, owner and latest-button violations were
  all zero. Maximum unchanged-top run during expected motion was one frame. Final stable
  physical gaps were at most one pixel. Idle natural return passed in both runs.
- Supplemental real UI checks verified normal composer send (live, gap 1), keep-view send
  (reading, gap 239), and find entry/query/close after reading effective persisted shortcuts.
  Earlier scoped checks covered native thumb drag, PageUp/PageDown and loaded message targets.
- These are development Electron CDP browser-input tests with a real sidecar, not physical
  trackpad/mobile-device tests. Not every Phase 6 edge case was independently repeated on
  hardware; history/session races, measurement invalidation and short-session intent semantics
  also rely on automated regressions and source review. Massive-history performance stress
  and exhaustive platform/input-device combinations remain outside this acceptance coverage.
- git diff --check passed. No commit, push or remote action was performed. The installed
  OpenCode application was not stopped or modified.

## Execution log

- Phase 0 started: Luna state baseline and environment QA assigned. Plan recorded before implementation.
- Phase 0 state baseline: 30 focused tests passed; full session tests reported 379 passed and
  one existing session-render-state object-identity failure. No baseline source edits.
- Phase 1 assigned to viewport_luna, limited to the existing navigation model/tests.
- Phase 2 optional ScrollView controlled-position API assigned to viewport_input_luna;
  it is unused until the atomic core cutover and preserves other callers' default behavior.
- Phase 1 reviewed: existing intent model extended without a second owner; 27 model tests
  and app type checking passed. Repeated same intent is idempotent; user takeover retains
  superseded-hash protection and asynchronous actions keep their original tokens.
- Phase 2 ScrollView preparation: 9 focused tests and UI type checking passed. Actual
  component delegation remains a composed/runtime verification item, not a claimed unit result.
- Phase 2 geometry preparation accepted: 50 focused tests and app type checking passed,
  including combined user-past-anchor plus shrink invalidation.
- Phase 0 runtime: no development CDP target found; installed packaged app is separate and
  must remain untouched. QA worker assigned safe dev startup and pre-cutover real sidecar baseline.
- Phase 3 core cutover assigned to the same state worker with exclusive core-file ownership.
- QA identified a current-worktree development runtime and created a dedicated test session.
  The pre-cutover stream attempt was interrupted by sidecar shutdown and live-edit renderer
  errors; this is NOT a passing baseline or acceptance run. Harness assertions are being
  strengthened before any post-cutover run.
- Parent independently reran model/geometry/estimate/ledger suites: 133 passed.
- Core intermediate checkpoint: app type check and 220 focused tests passed, but NOT accepted.
  Review found remaining target failure/settlement, delayed hash acknowledgement, mount lifetime,
  virtual-offset synchronization, input provenance, and double-correction issues. These are
  mandatory core completion gates; runtime QA remains paused until addressed.
- Estimate helper prep: 48 focused tests passed; shared diff columns and explicit desktop/mobile
  insets await timeline integration. Two-row overflow cap is preserved.
- Acceptance harness now fails on missing evidence, uses backend receipt/status, counts only
  post-return growth, and verifies intent through growth plus stable final tail alignment.
  Parent bundled it successfully; no passing live acceptance result exists yet.
- A separate Luna reviewer is adding real Solid hash-hook regressions while the core worker
  addresses integration findings. No shared production file has multiple writers.
- Real MemoryRouter/hash-hook regressions now expose an external-navigation regression:
  five cases pass; intentionally navigating to the previously cleared hash is incorrectly
  rejected as stale. The failing case remains a required fix, not a relaxed assertion.
- Core worker reported a compile/test checkpoint, but parent did not accept it as complete:
  a second immediate tail write, overly broad layout authorization, target deadline lifecycle,
  and missing reconciliation triggers must be removed/fixed before the runtime gate opens.
- Router simplification correction: inspection of installed @solidjs/router 0.15.4 routing.js
  shows lastTransitionTarget checks before both reference updates and navigateEnd. Replaying
  history.set after acknowledgement simulates a NEW external navigation, not a delayed own
  router callback. Do not add marker registries or beforeLeave flags to duplicate router
  sequencing. Preserve pending own hash acknowledgements and scroll:false; after acknowledgement
  a changed hash is an external intent. Tests must exercise real overlapping own navigate calls,
  application stale-token callbacks, and genuine back/forward rather than rejecting external
  history events under a fabricated "old commit" label. Earlier marker-based changes are removed.
- User reported repeated Jump to latest flashing after natural up/down return. Source confirms
  composer visibility still depended on overflow && !physicalBottom, so smooth catch-up can
  oscillate the button even with a stable following intent. Added explicit Phase 3 UI and
  Phase 5/6 runtime requirements. Helper owns composer-only changes; core owns the derived
  page prop; QA owns DOM visibility assertions. This is not yet marked fixed/verified.
- Browser-condition suite independently passed 30 tests; UI focused tests passed 11 tests;
  app and UI type checks passed at the pre-runtime gate.
- Runtime setup correction: desktop uses DesktopMemoryRouter, not browser location routing.
  Page.navigate restored the prior session and the identity assertion correctly stopped QA.
  Harness now uses the existing app navigation path and verifies active in-memory route,
  timeline session ID, and owner session key before sending/scrolling.
- First text runtime pass (sampled, not per-frame): 154 post-return growth observations with
  stable following and hidden latest action, real sidecar receipts, final convergence and idle
  return. Evidence: /private/tmp/opencode-viewport-qa/text-acceptance-20260922-r3.json.
- First tool runtime run completed two safe shell calls and viewport checks, but the receipt
  oracle selected the first tool-call assistant rather than the final text assistant. It remains
  recorded as incomplete; receipt selection now follows the test turn's parentID chain.
- Frame-probe r5 incorrectly included intentional idle-away input in a following segment.
  Harness now records separate explicit main-follow and idle-follow segments; unexpected
  reading within either segment is still a failure. Earlier evidence is preserved.
- Before final runtime rerun, a known input defect is corrected: observed negative clamping
  must not synthesize upward user intent. Scoped real input provenance is retained through
  touch inertia until scrollend; scroll observations can only confirm downward return.
  Explicit viewport scrollend forwarding and shared return threshold are under final review.
- Input provenance review complete: inner viewport explicitly receives scrollend; nested events
  cannot clear outer provenance; touch coordinates remain owned by touch lifecycle. Positive
  downward observations can confirm following, but cannot synthesize upward takeover.
- Frame-level text run before the final measurement fix passed identity, owner, button visibility,
  growth, final alignment and idle return checks (152 post-return growth observations):
  /private/tmp/opencode-viewport-qa/text-acceptance-final3-20260922.json.
- Observer starvation fix reviewed: stale queued width/content metadata refreshes current
  layout height instead of dropping the final sample indefinitely. All reads precede writes;
  stable key lookup replaces captured numeric indices; matching samples perform no forced read.
  Measure tests passed 52 cases; app/UI type checks and 30 browser-condition tests passed.
- Final post-measurement runtime QA is running with explicit follow segments, per-frame motion
  and button checks, turn-scoped text/tool receipts and verified output markers. No final
  acceptance claim is made until those new artifacts and supplemental UI checks are reviewed.
- Post-measurement text/tool runs passed 11,605 total RAF samples with zero identity/owner/button
  violations, sustained movement, real turn receipts, verified tool output markers, and stable
  final gap <= 1. These artifacts precede the final physical-return confirmation refinement.
- Return-to-following now confirms physical root geometry instead of a potentially underestimated
  virtual extent. Page pre-input and timeline observation share physical-bottom helpers.
- A later physical-final run reported 166 reading/button frames. Parent correlated the first
  divergence with renderer.old.log at 12:42:01.015-12:42:01.023: actual trusted upward wheel
  events (-1, -4, then a variable native trajectory) arrived about seven seconds into the
  follow-only segment, outside the harness's fixed -18.75/+23.5 input phase. This run is
  contaminated by additional input, NOT evidence that following detached without input.
  The original failed artifact remains preserved. QA must detect unexpected input and abort,
  not suppress legitimate user takeover or count the contaminated run as passing.
- Final simplification removed UI pendingMessage/seekingMessageId mirrors and hook setter
  feedback. Scoped layout.pendingMessage.consume remains a one-time handoff, not another owner.
  A speculative bootstrap flag/microtask was removed: the real router already provides the
  session scope synchronously. The router test fixture now derives scope from actual routes.
- Parent reviewed the final production source and independently reran browser tests, session
  tests, app/UI type checks and whitespace validation. Final canonical artifacts above replace
  earlier intermediate passes as acceptance evidence; failed/contaminated artifacts are retained.
- Jump to latest flashing is fixed by canonical following plus overflow visibility, not a
  debounce, timeout or visibility latch. Real physical gap remains separately observable;
  per-frame intent and motion checks prevent hiding an ownership defect behind the button.
