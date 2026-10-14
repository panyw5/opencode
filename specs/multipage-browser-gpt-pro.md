# Multipage Browser and GPT Pro Implementation Plan

## Objective

Each agent session owns an independently controlled browser page. GPT-Pro
consultations from different owners can send and track replies concurrently,
without changing another page's input, navigation, answer, or control state.
ChatGPT login remains shared; no API, Codex, Work, or alternative-model fallback
is introduced. The website's actual model selection remains authoritative.

The implementation removes the app-wide single consultation channel and fixes
the stopped-session background-consultation residue that could block it.

## Identity and Ownership

| Identity | Meaning | Sharing |
| --- | --- | --- |
| `owner` | Backend-derived project directory and agent session ID | Never inferred from a model name or supplied arbitrary target |
| `pageID` | One WebContents/CDP target | Never shared between concurrent consultations |
| `profileID` | Electron session partition | ChatGPT pages may share `persist:consult-gpt-pro` |
| `consultationID` | One persisted request, send evidence, answer and outbox | Bound to owner and page |
| `epoch` | Native page incarnation | Changes when the page is destroyed and recreated |

For protocol compatibility, `partition` temporarily remains a deprecated page
routing alias. It must never be interpreted as shared login identity when
indexing pages. New state exposes `pageID` and `profileID` separately. Legacy
payloads without `pageID` fall back to `partition`.

Generic browser tools derive their page from the invoking session. Consultation
browser tools resolve the authorized consultation first. Tool inputs cannot
choose another owner or an arbitrary shared profile. Desktop renderer controls
remain user controls, distinct from agent tool authorization.

The initial policy permits one unfinished consultation per owner. Duplicate
request IDs return the existing request; a new request while that owner's page
is occupied reports `owner_page_busy`. Explicit follow-up/intervention chains
retain the existing ownership and no-resend guarantees. Terminal pages remain
inspectable until closed or safely reaped.

## Execution and Resource Policy

The manager owns independent runners and bound drivers instead of one global
driver and `active` consultation. Default concurrency is four, configurable
within one to eight. Paused or recovery-blocked jobs release execution capacity
without relinquishing their own page to an unrelated request.

Page mutations are serialized. Snapshot/read operations cannot race mutations
or accept obsolete page evidence. Cancellation invalidates future dispatch at
the upload and trusted-send boundaries, including commands waiting for a lock.
Already dispatched website requests cannot be undone by changing local state.

Foreground/background controls whether the parent waits; it does not determine
page identity. Automatic jobs stay hidden and use target-local CDP input, not
native window focus. Explicit user viewing or takeover may present a page.
Hidden automation pages retain a usable offscreen viewport rather than a
one-pixel layout. Per-target CDP device metrics and focus/visibility emulation
keep layout and animation-frame scheduling active without native window focus.
The sidebar display lease is separate from task execution.

## Lifecycle Rules

| Event | Required behavior |
| --- | --- |
| Background promotion | Keep the same request, page and owner; send nothing new |
| Pause or recovery handoff | Affect only that consultation; allow other owners to run |
| Explicit session stop | Cancel that owner's foreground and background consultations |
| Normal completion of a parent turn | Do not cancel an explicitly backgrounded consultation |
| Stop consultation | Persist cancellation first; website stop is best effort with separate diagnostics |
| Page close or renderer crash | Stop accepting that page's evidence; do not silently recreate or resend |
| App restart, cancelled/completed | Never requeue |
| App restart, paused | Remain paused; never reclaim global execution capacity |
| App restart, confirmed background send | Reopen the original conversation and track the original user turn only |
| Uncertain send | Require explicit reconciliation; never automatically resend |

Queued creation and attachment staging must be fenced against an owner stop
that happens before the job is persisted. A stale create completion cannot
introduce a new active job after the stop. A later fresh user request can create
a new consultation; stopping an owner is not a permanent ban.

Reply acceptance retains the exact prompt, original user ID, attachment proof,
conversation and page-generation checks. Outbox delivery remains durable and
scoped to the owning project/session. Late tracking results cannot overwrite a
cancelled or paused phase.

### Lifecycle Cleanup Extension

1. Persist the final phase, complete reply and durable outbox before releasing
   driver observers, run tokens, operation fences and staging references. Wait
   for pending inspection/mutation/stop operations to settle before releasing
   their controls. Retain owner cancellation epochs to fence stale admission.
2. Terminal hidden pages receive a 30-second grace. A selected page, pending
   explicit View, or selected page temporarily hidden behind a modal remains
   protected. A close callback is fenced by page identity, native epoch and
   timer token, including after asynchronous inspection.
3. Inspect the actual page before destruction. Preserve unknown/error states,
   active generation, manually changed navigation, drafts, attachments or user
   turns. A cancelled unsent draft is owned only with matching prompt and
   attachment proof. Preserve page scheduling until safety is known. Unsafe or
   unavailable inspection retries after 60/120/240 seconds, capped at five
   minutes; protection changes reset the grace. Paused and uncertain jobs never
   enter automatic terminal cleanup.
4. Bound resident consultation pages separately from concurrent runners:
   default eight, at least the configured concurrency, maximum 32. Serialize
   reservations and count pending opens. Evict only inspected, safe, hidden
   terminal pages; otherwise report `page_capacity`. Recheck dispatch
   eligibility after asynchronous allocation so stop/pause cannot be undone.
   Shared login pages and ordinary/user browser pages are outside this budget.
5. Stopping a settled paused consultation may require a temporary control
   driver for its captured live page identity and epoch. This driver adopts the
   existing page only, never opens or submits, and disposes after native stop.
   Stale leases cannot target a recreated page.
6. Terminal View resolves the current successor and reads the full saved
   answer, not the abbreviated list/status result. Safe Markdown preview does
   not allocate a native page. Explicit "Open original webpage" restores the
   original conversation without filling/submitting. Active/recovery View
   remains a live-page handoff. Result dialogs must survive replacement of a
   settings dialog; resolve before replacing its source root.
7. Teardown retains the shared login profile, saved reply, send evidence and
   unacknowledged outbox. History pruning removes only owned copied attachment
   staging, never original source files, and retains recovery/pinned/outbox
   records. Native-page destruction and result-history retention are distinct.

The lifecycle integration harness is
`packages/desktop/scripts/gpt-pro-lifecycle-e2e.ts`. Supply a completed result
from the earlier real multipage QA run and the prior viewed result to restore.
It never submits a website prompt: it checks read-only access without page
allocation, explicit original-page restoration, selected-page protection over
the grace interval, hidden-page reclamation and unchanged saved answer/proof.

## Ordered Implementation Stages

### Stage 0 Inventory and Baseline

Read root/package instructions and identify browser, IPC, bridge, preload,
renderer, tool, background-delivery and explicit-stop boundaries. Inspect
working-tree changes without reverting them. Verify which desktop instance is
running before launching a development app.

Acceptance: affected interfaces and compatibility decisions recorded; existing
targeted tests pass before behavior changes.

### Stage 1 Native Page and Profile Foundation

Change BrowserController maps, CDP lookup, epochs, display and teardown to page
identity. Add an explicit page/profile creation API and immutable owner/kind
metadata. Fence native callbacks captured by obsolete WebContents instances.

Acceptance: two pages sharing one Electron profile have separate native views
and CDP targets; closing or recreating one leaves the other unchanged; stale
callbacks cannot remove a replacement page.

### Stage 2 Cross Layer Routing

Preserve new metadata through browser protocol schemas, hello snapshots, update,
close and console events. Migrate preload, renderer tab store, display frames,
previews and backend facade to page-scoped routing with legacy fallbacks.

Acceptance: shared-profile pages never merge in UI or server state; stale close
and update events are ignored; background events do not activate the sidebar;
consultation console retrieval resolves the authorized page instead of profile.

### Stage 3 Independent Consultation Runners

Replace the global pump with bounded independent runners and a driver factory.
Persist and expose consultation page identity. Implement owner admission,
per-page operation serialization, snapshot fencing, hidden viewport support,
target-local input and restart/no-resend rules.

Acceptance: distinct owners send/generate/complete independently; paused or
failed A does not prevent B from starting; same-owner conflicts are explicit;
recovery still works without a global active-job lock; cancellation during a
deferred read or send cannot accept late completion or dispatch a late send.

### Stage 4 Session Stop and User Controls

Connect the explicit backend session-stop path to owner-scoped consultation
cancellation, including jobs being created. Log bridge absence/failure rather
than silently claiming desktop cancellation. Preserve normal background
completion behavior. Distinguish owner pages in the browser UI and expose
resource limits/reasons using established settings and localization patterns.

Acceptance: explicit stop cancels only the intended owner's jobs, including
background and paused ones; normal parent completion does not cancel them;
restarting cannot revive cancelled jobs; wrong-owner control fails.

### Stage 5 Review and Real Integration

Run targeted desktop, app and backend regressions and their typechecks. Perform
read-only review of the final diff. Use the development Electron renderer on
CDP 9222 for frontend and real sidecar testing; never quit the installed app.

Send requests in two temporary project sessions, inspect their independent
native page identities and shared profile, then verify original website user
turns, matching answers and durable parent inbox delivery. Separately stop one
session while the other continues. Read backend/desktop logs directly.

The parent-owned harness is
`packages/desktop/scripts/gpt-pro-multipage-e2e.ts`. It records a manifest before
dispatch. `--watch <run.json>` only observes saved requests, never reposts them.
`--cancel-first` exercises explicit sidecar session-stop isolation. A mock or
fixture pass is not evidence of a real ChatGPT integration pass.

`packages/desktop/scripts/browser-multipage-sidecar-e2e.ts` independently tests
two real GPT-6-Luna agents operating separate local browser pages through the
actual sidecar. It verifies completed navigate/read/click/read tool traces, exact
page counters, separate native targets/profiles, and received agent replies.
This test does not substitute for the ChatGPT consultation integration gate.

## Validation Commands

Run test commands from their package directories, not the repository root.

```sh
# packages/desktop
bun test src/main/browser-presentation.test.ts src/main/browser-cdp.test.ts src/main/gpt-pro-controller.test.ts src/main/gpt-pro-driver.test.ts src/main/gpt-pro-probe.test.ts
bun run typecheck

# packages/app
bun test --preload ./happydom.ts src/browser/tabs.test.ts src/browser/display.test.ts
bun run typecheck

# packages/opencode
bun test test/browser test/tool/gpt_pro_consult.test.ts test/session/gpt-pro-background.test.ts
bun run typecheck

# repository root, only against an already verified development renderer
bun packages/desktop/scripts/cdp.ts info
bun packages/desktop/scripts/browser-multipage-sidecar-e2e.ts
bun packages/desktop/scripts/gpt-pro-multipage-e2e.ts
bun packages/desktop/scripts/gpt-pro-multipage-e2e.ts --cancel-first
git diff --check
```

Before using app keyboard shortcuts, read effective overrides from the desktop
IPC settings store. Prefer direct UI controls for the integration harness.

## Logging and Completion Criteria

Log owner, consultation, page, profile, epoch, operation stage and stop/recovery
outcomes as strings. Do not log cookies, credentials, full prompts, attachment
contents or complete answers. Preserve diagnostic evidence for failed tests.

The implementation is complete only when regression/type checks pass and actual
sidecar send/receive plus independent-page and stop-isolation checks have been
performed. If login, website verification or another external condition blocks
real testing, record that limitation separately; do not label unperformed tests
as passed. Do not push, commit or run remote actions without a separate request.

## Current Progress

- Stage 0 complete: 113 desktop and 50 backend baseline tests passed.
- Stage 1 complete: page/profile foundation, stale-callback tests and typechecks passed.
- Stage 2 complete: shared-profile routing tests and desktop/app/backend typechecks passed.
- Stage 3 complete: independent runners, dispatch/read fencing and restart/retention tests passed; live integration remains unverified.
- Stage 4 complete: owner-scoped stop, creation fencing, legacy queue migration and UI configuration/reasons passed targeted tests and typechecks.
- Stage 5 partially complete: final review, local real-agent integration and paused-consultation stop isolation passed. Real ChatGPT concurrent answer delivery and stop-during-generation checks remain blocked on browser verification.

## Verification Results

Validated on 2026-10-10 in development Electron on CDP 9222. The installed
OpenCode application was not stopped or updated. No commits, pushes or GitHub
Actions were performed, and unrelated user edits were preserved.

| Check | Result |
| --- | --- |
| Desktop browser, driver, controller, probe and notification regressions | 156 passed |
| App browser tab/display regressions | 16 passed |
| UI GPT-Pro tool regressions | 9 passed |
| Backend browser, consultation tool and background-delivery regressions | 55 passed |
| Backend cancellation and normal-completion regressions | 17 passed |
| Desktop, app and backend typechecks | Passed |
| Final read-only implementation review | No remaining serious findings |
| Two real GPT-6-Luna agents navigating, clicking and reading independent local pages | Passed; both actual counters and received replies matched |
| Explicit sidecar stop of paused consultation A, with consultation B unchanged | Passed; A cancelled and B remained paused |
| Final real ChatGPT concurrent answer delivery and website stop during generation | Not passed; browser verification prevents sending |

The final blocked consultation pair was never sent. One intermediate build
received and verified a real ChatGPT marker response after a manual viewport
repair; this is not counted as a pass for the final concurrent implementation.
Earlier unconfirmed send attempts were cancelled rather than repeated. The real
ChatGPT harness preserves manifests and supports watch-only observation.

An existing shell-output truncation cancellation test, which uses a fixed
150-millisecond delay, failed once under concurrent load and passed both an
isolated rerun and the subsequent full cancellation subset. Its behavior and
assertions were not weakened.

## Lifecycle Extension Verification

Validated on 2026-10-10 against the updated development Electron. GPT-6-Luna
implemented core lifecycle cleanup and cached-result UI in separate stages;
the parent integrated review fixes and performed the live tests.

| Check | Result |
| --- | --- |
| Desktop browser/CDP/controller/driver/probe/outbox regressions | 173 passed |
| App browser tab/display regressions | 16 passed |
| UI result resolution, preview, tool and handoff regressions | 21 passed |
| Backend browser/consultation/background regressions | 55 passed |
| Desktop/app/UI/backend typechecks and diff whitespace check | Passed |
| Native lifecycle harness using an existing real ChatGPT QA answer | Passed: cached read allocates no page; explicit open protects selected page for 35 seconds; hidden page closes after 30 seconds; saved text/HTML/user evidence unchanged |
| Actual history cached-result Dialog and explicit original-page button | Passed: full saved reply rendered, no implicit page allocation, explicit original page reopened with new epoch, no prompt replay, Dialog closed and browser visible |
| Actual tool cached-result Dialog covering the selected browser for 35 seconds | Passed: selected protection and epoch retained, no new native page |
| Two real GPT-6-Luna sidecar agents on independently controlled local pages | Passed: both navigate/read/click/read traces, exact native counters of one, separate targets/profiles and received replies verified |
| Final read-only review | No actionable findings |

Review regressions also cover cancellation during asynchronous resident
allocation, a fresh request admitted before the cancelled allocation settles,
stopping a paused job after driver release without stopping another page,
unsafe-page retry backoff, modal selection protection, stale timer/epoch
fencing, successor-aware fallback and delayed dialog completion ownership.

The sidecar fixture initially placed its counter in a status region excluded
from browser snapshots, then nested that region inside a heading whose
accessible name was empty. Actual clicks occurred, but received answer checks
failed; those runs were not passes. A direct text heading makes the current
counter observable through the real browser tools, and the final run passed
without loosening result or native-counter assertions.

Live artifacts are in `opencode-lifecycle-e2e-oCnqzj` and
`opencode-agent-pages-e2e-OwcvKq` under the macOS temporary directory. The prior
viewed completed result was restored; temporary agent pages were closed and
their sessions stopped. The installed application was not stopped or updated.
The separate real ChatGPT concurrent-send/stop-in-generation gate above remains
unverified; these cleanup tests reused a completed answer and sent no new
ChatGPT prompt.
