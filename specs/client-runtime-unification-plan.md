# Shared Client Runtime Implementation Plan

Status: execution started on 2026-11-01. P0 fixtures and a P1 contract/transport slice are implemented; no full phase gate is signed off. See the execution record in section 15.

Design: [Shared Client Runtime Services](./client-runtime-unification.md).

Baseline: commit `576cb017ec` and the existing uncommitted cross-project session-list repair. Preserve unrelated working-tree changes. This plan does not authorize a push, public tunnel activation, backend database rewrite, or replacement of existing user preferences.

## 1. Execution Order

Implement service contracts before moving state owners. Introduce transactional persistence before migrating critical records. Fix the already-observed sidebar ordering race before undertaking the larger state migration.

| Phase | Outcome                                                       | Dependency                         | Design stages             | Primary audit items |
| ----- | ------------------------------------------------------------- | ---------------------------------- | ------------------------- | ------------------- |
| P0    | Reproducible baseline and regression fixtures                 | None                               | S0                        | D1-D12              |
| P1    | Scoped runtime, port contracts, transport parity              | P0                                 | S1 foundation             | D4, D6, D7, D10     |
| P2    | Shared host-directory contract and workspace identity service | P1                                 | S1 identity               | D1, D2              |
| P3    | One navigation owner with explicit intent ordering            | P1; P2 for identity integration    | S4, moved earlier         | D3, D5              |
| P4    | Transactional client persistence and conflict handling        | P1                                 | S3 persistence foundation | D9                  |
| P5    | Canonical project registry and unified admission commands     | P2, P4                             | S2                        | D1, D8              |
| P6    | Resumable migration of legacy identity references             | P3, P4, P5; reader facades from P1 | S3 migration              | D1, D4, D9          |
| P7    | Scoped session, draft, file and review state                  | P1, P3, P6                         | S5 state ownership        | D4, D5, D11         |
| P8    | Capability-driven feature behavior across all surfaces        | P1, P2, P5, P7                     | S5 capability integration | D7, D10, D12        |
| P9    | Remove compatibility bypasses and complete parity gates       | P0-P8                              | S6                        | D1-D12              |

P3 and P4 are independently reviewable after the runtime foundation. This dependency does not imply concurrent edits to shared files. P5 must not introduce a new durable registry before P4 can commit it safely. P6 must not publish a remapping before all affected readers understand the new identity format.

### Delivery Milestones

| Milestone | Phases | User-visible result                                                                                                           |
| --------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| M1        | P0-P3  | Consistent host-directory resolution contracts and stable one-click sidebar selection; saved legacy records remain compatible |
| M2        | P4-P6  | Existing remote projects, copied paths, tabs and drafts use one canonical workspace mapping without data loss                 |
| M3        | P7-P8  | Backends/domains are isolated; session/draft lifecycles and unsupported operations have common semantics                      |
| M4        | P9     | Compatibility-only branches are removed and the adapter parity suite is a release gate                                        |

## 2. Implementation Rules

- Keep each phase runnable and reviewable. Prefer one contract change and its integrations per commit, not unrelated mechanical file batches.
- Keep one writer for a state slice. A compatibility facade delegates to the selected owner; it does not independently maintain a second mutable copy.
- Allow read-only comparison during rollout, but never shadow-submit messages or dual-register projects.
- Preserve the current remote fetch and session-list repairs until the shared identity boundary and migration cover every old entry point.
- Distinguish canonical logical paths from opaque identity keys, display strings and route encoding. Reuse existing core path primitives.
- Maintain native/gateway authorization boundaries, credential redaction and remote route restrictions. A capability manifest does not replace enforcement.
- Use explicit generation/revision tokens for correctness. Cancellation, timing delays and UI unmounts are not correctness barriers.
- Keep development and installed app profiles isolated. Tests must not mutate host-user sessions, revoke unrelated devices, or stop the installed app.

## 3. P0 Baseline and Regression Fixtures

### Work

1. Record the baseline commit, scoped local fixes and unrelated working-tree files. Keep the design, plan, current repairs and unrelated menu/editor changes independently reviewable; do not stash or reset user work.
2. Capture fixtures for a legacy `~/apps/opencode` project alongside `/Users/lelouch/apps`, including registry entries, project preferences, route, tabs, draft content/context and workspace caches. Use synthetic copies, not writes to the live profile.
3. Extend the current sidebar reproduction to assert the selected project, unchanged main route and actual expected session IDs. Capture the initialization-overwrite failure as a distinct coordinator regression case rather than hiding it with an automatic second click. Record the pre-fix failure evidence in P0; enable the desired invariant as a passing gate with the P3 fix.
4. Add delayed/failing ports for canonical resolution, connection changes, hydration and session-list completion. Add fixtures with the same directory/session IDs on two independent backends.
5. Freeze intended desktop/Web differences: native picker, remote cookie/CSRF, denied host administration, independent local preferences, browser history and responsive presentation.
6. Produce an entry-point checklist covering Home input, directory dialog, native picker, drag/drop, deep links, recent sessions, project tasks, rail actions, tab restore, copy and session metadata repair.

### Files

Existing integration tests: `packages/desktop/scripts/remote-sessions-cdp.ts`, `remote-access-cdp.ts`, `remote-access-e2e.ts`; app tests for `context/global-sync`, `context/session-tabs`, `context/server`, `utils/persist`, and `pages/layout/helpers`; desktop `src/main/native.test.ts` and `src/main/remote/gateway.test.ts`.

Proposed new fixtures live under `packages/app/src/services/test-utils/`. Place test-only state snapshots there, not in production profile directories.

### Gate and Recovery

The baseline passes its existing tests, and the reproduction evidence distinguishes the two known problems: request-path failure versus a successful response filtered out by mismatched state. Committed P0 characterization tests remain green; a known pending invariant must have an explicit owning phase rather than an unexplained red test or permanent skip. A test cannot pass merely because another project's rows are visible. No production logic changes are required to complete P0.

## 4. P1 Runtime Scope and Port Contracts

### Work

1. Define `AuthorityKey`, `RuntimeScope`, `WorkspaceRef`, scoped session/draft keys, domain error codes and operation capability types in a DOM-free contract module.
2. Define stable authority mapping for managed sidecar/profile, configured HTTP endpoint, SSH connection and WSL distro. Keep unmanaged loopback endpoints separate. Exclude credentials and ephemeral managed-sidecar ports from persistent identity.
3. Define runtime generation changes for backend replacement/restart and connection switches. Dispose obsolete streams, timers and requests without changing stable persistent workspace identity.
4. Define window/tab ownership separately from authority ownership. Active route, preview selection and focus are window-local; project registry and retained draft documents may be profile-shared. Specify window lifecycle IDs and restore-slot IDs before moving tab persistence.
5. Introduce `ClientRuntime` composition using the current Server/GlobalSDK state as its initial owner. Adapt existing consumers through selectors; do not start a second SSE subscription or health poll.
6. Standardize `Request` plus `RequestInit` behavior, abort propagation, header overrides, body consumption and error mapping. Correct the desktop Request-input override discrepancy with a common tested wrapper.
7. Introduce explicit streaming and ordinary-request transport ports. Keep external API requests separate from host requests, and prevent credentials from being copied between authorities or origins.
8. Introduce a minimal effective capability snapshot and a conservative legacy-server adapter. Split `reloadClient` from `restartHost`; no shared command may ambiguously perform either one.

### Files

Proposed: `packages/app/src/services/contracts.ts`, `runtime.ts`, `transport.ts` and their tests. Integration: `packages/app/src/app.tsx`, `context/server.tsx`, `context/global-sdk.tsx`, `context/platform.tsx`, `entry.tsx`, `utils/server.ts`, `remote/bootstrap.ts`, and `packages/desktop/src/renderer/index.tsx`.

Add backend/gateway capability fields only through compatible DTO extensions. If a lightweight ordinary-Web directory API is needed, settle its route/schema and SDK generation impact in P1; do not expose a new route incidentally during a UI refactor.

### Tests

- Same path and same session ID on different authorities produce different keys; stale directory metadata within one authority does not duplicate a session tab.
- Managed sidecar port changes preserve its authority but invalidate old in-flight results.
- Request overrides and aborts behave identically through desktop and HTTP adapters; a body is not consumed twice.
- Reconnect creates exactly one active event subscription, with all retired subscriptions disposed.
- Native and remote capability manifests retain their intended restrictions.

### Gate and Recovery

Existing application behavior is unchanged except explicitly tested adapter corrections. Runtime consumers use a compatibility facade over one owner. Rollback can select the old facade because no persisted identity migration has occurred yet.

## 5. P2 Shared Directory Resolution and Workspace Identity

### Work

1. Extract server-only input checks, home expansion, explicit-base resolution, existing-directory validation and `realpath` into a common host-directory implementation. Keep pure path identity operations in the existing core path module.
2. Make native IPC and the remote gateway call that implementation. Keep native allowed-root registration and gateway authentication outside it.
3. Give strict validation, directory listing and offline/unresolved native-drop retention different operation contracts. Do not reuse permissive dropped-folder retention as project validation.
4. Implement `WorkspaceIdentity.resolve`, canonical record lookup, display-path formatting and canonical copy-path selection. Successful identity resolution returns a case-preserving host path plus an opaque scoped workspace ID.
5. Implement scoped single-flight resolution with explicit timeout, bounded cache lifetime, consumer cancellation and generation invalidation. Failed validation must not become an empty successful result or an eternal cached failure.
6. Map virtual extra-agent workspaces separately. SSH/WSL resolution executes on the selected filesystem; it never expands a remote home path using the local desktop's home.
7. Implement or adapt the ordinary-Web host-resolution port according to the P1 API contract. For old backends without a safe resolution operation, expose a clear unsupported/upgrade state instead of silently admitting an unvalidated path.
8. Keep legacy raw-path requests working through compatibility adapters until P6/P9. Do not update all registry records as a side effect of the first successful lookup.

### Files

Proposed server-only module: `packages/util/src/host-directory.ts` with fixture-driven tests. Proposed client module: `packages/app/src/services/workspace-identity.ts`.

Adapters: `packages/desktop/src/main/native.ts`, `native-path.ts`, `remote/directory.ts`, `remote/gateway.ts`, preload types/handlers, desktop renderer, `packages/app/src/remote/directory.ts`, and selected SSH/WSL directory adapters. If needed, use the existing opencode HTTP API group/handler/schema conventions and regenerate the SDK rather than hand-editing generated client files.

### Tests

- `~`, absolute paths, verified symlinks, spaces, Unicode names and root directories resolve consistently.
- Parent/child directories and separate worktrees stay distinct even if they share a repository ID.
- Relative input without an explicit base, missing paths, files, permission errors, control characters and unsupported operations have distinct failures.
- POSIX/Windows host combinations preserve host semantics; virtual namespaces bypass filesystem resolution.
- Concurrent lookups share work, but canceling one consumer does not cancel the others.
- IPC/gateway authorization and path-log redaction remain intact.

### Gate and Recovery

Every adapter passes the same strict directory contract suite. A Node filesystem module must not appear in the browser bundle. Rollback retains existing registry data and the current compatibility repairs.

## 6. P3 Navigation Ownership and Race Repair

### Work

1. Extend the existing SessionTabs coordinator into a window-owned navigation service; preserve its public close/activate/draft APIs behind a facade.
2. Move module-level intent, close handoff, tombstones and reconciliation state into the durable runtime/window owner, not a transient page component.
3. Model route workspace, active conversation workspace and sidebar preview workspace separately. Define explicit events for route restore, user preview, session activation, Back/Forward, close, deletion and draft promotion.
4. Give initialization a captured selection epoch. Any later explicit preview invalidates older pending route-to-sidebar work, including work waiting for project metadata or composer focus.
5. Route layout effects through coordinator events. Remove direct competing writes from pending route reconciliation, fallback effects and session-open helpers incrementally.
6. Keep explicit subsequent session navigation and browser Back authoritative for their own new intent. Fixing initialization must not permanently pin a previously previewed project.
7. Remove automatic reselection from the cross-project QA test. A single deliberate selection must remain selected after all delayed initialization finishes.

### Files

Primary: `packages/app/src/context/session-tabs.tsx`, `session-tabs.test.ts`, `pages/layout.tsx`, `context/layout.tsx`, route/deep-link integration and `packages/desktop/scripts/remote-sessions-cdp.ts`.

Proposed pure transition tests can live beside `services/navigation.ts`; reuse the existing coordinator rather than creating two intent ledgers.

### Tests

- Page on A, one sidebar click on B, then delayed A metadata/bootstrap/autofocus: B stays selected and A's conversation remains open.
- Explicit session activation, Back/Forward and deep links select the requested conversation and appropriate project.
- Rapid A/B clicks and canceled prepares never commit superseded intents.
- Parent/child close, active-neighbor fallback, archived/deleted tombstones and draft promotion preserve existing behavior.
- Two coordinator instances/authorities do not consume each other's handoffs or tombstones.

### Gate and Recovery

Both Electron and remote Web pass the one-click delayed-bootstrap regression without a second click, DOM retry or fixed settling delay. Changes affect runtime ordering only; persistent migration is still disabled, allowing a straightforward code rollback.

## 7. P4 Transactional Client Persistence

### Work

1. Define an asynchronous storage service with `hydrate`, revisioned `read`, compare-and-swap `commit`, subscription, migration-journal and recovery operations. Adapt existing `persisted` consumers through one facade.
2. Separate authority/profile-shared records from window-local route/tab/preview records. Define a schema version, expected revision and typed conflict result for every critical update.
3. Implement browser critical-state transactions using IndexedDB. Keep BroadcastChannel for revision notifications only; it is not the lock. Noncritical preferences may remain in localStorage behind the adapter.
4. Implement desktop critical-state commits in the main process with a per-scope serialized queue, expected-revision validation and atomic durable snapshot replacement. Do not implement read-modify-write independently in each renderer.
5. Put related registry/identity and draft transaction data in one versioned commit boundary. Store large binary attachments separately with durable references; do not duplicate message history or provider secrets in client snapshots.
6. Hydrate before admitting mutations for that scope, or queue commands with their intent/revision. A late hydrate result cannot overwrite newer user input. Do not gate unrelated workspaces on slow model catalogs.
7. Implement migration prepare/commit markers, recoverable staged data and rollback exports. Revision notifications trigger a reload of committed state; late notifications never move state backward.
8. Handle old tabs/windows and blocked database upgrades explicitly. Stale writers must reject incompatible schema writes rather than overwrite a migrated record.

### Files

Proposed: `packages/app/src/services/client-persistence.ts`, browser storage adapter and transaction tests; `packages/desktop/src/main/client-state.ts` and tests.

Integration: `packages/app/src/utils/persist.ts`, `persist.test.ts`, desktop preload types/index, `src/main/ipc.ts`, `src/main/store.ts`, renderer storage adapter and relevant profile/window initialization.

### Tests

- Simultaneous writers from two browser tabs or Electron windows cannot silently lose an update.
- Conflicting nonempty draft edits return a conflict and preserve both revisions; they are not blindly replayed as last-write-wins.
- Failure before staging, after staging, after durable commit and before notification recovers to a complete version.
- Quota/disk errors, IPC failure and browser database-upgrade blocking leave prior committed data readable.
- Large-record and transaction latency are measured with representative fixtures before selecting final snapshot size limits.

### Gate and Recovery

The same persistence conformance suite passes for both adapters. No live legacy profile is migrated yet. A rollback discards only unused staged test/new-schema data, never the old profile contents.

## 8. P5 Canonical Project Registry and Admission Commands

### Work

1. Extract project membership, order, last-project state and project preferences into the registry owner. Layout becomes a selector/geometry consumer; Server retains connection state rather than owning another project collection.
2. Define `open(rawInput)` as a boundary command that resolves identity, checks the runtime generation/capability and commits one canonical reference. Internal commands accept `WorkspaceRef`, not arbitrary display strings.
3. Define local project registration separately from optional backend discovery/visibility operations. Report partial failures explicitly; remote open must not issue a forbidden host-only registration request.
4. Convert every P0 entry point to the registry command. Preserve explicit new-draft intent: opening or previewing a project must not implicitly submit or create a conversation.
5. Make sidebar, session header and new-session copy actions obtain the canonical path from the shared reference. Use home abbreviations only in display selectors.
6. Deduplicate verified aliases while preserving project order, names, colors and expansion preferences. Do not merge parent/child directories or separate worktrees.
7. Provide a compatibility read facade for unresolved legacy records until P6 remaps them. Do not dual-write a legacy and new project registry.

### Files

Proposed: `packages/app/src/services/project-registry.ts` and tests. Integrations: `context/server.tsx`, `context/layout.tsx`, `pages/layout.tsx`, `pages/home.tsx`, `pages/home-path-input.tsx`, `components/dialog-select-directory.tsx`, deep-link handlers, project-task entry points, `pages/layout/sidebar-project.tsx`, `components/session/session-header.tsx` and `session-new-view.tsx`.

### Gate and Recovery

All new admissions store canonical scoped references; copying always returns the canonical absolute host path. Native picker, manual Web entry, remote browse and deep links have the same project-open result semantics. Existing legacy records remain recoverable, and the old UI accesses the one new owner through its facade.

## 9. P6 Legacy Identity Migration

### Work

1. Implement a read-only dry-run planner that inventories legacy records and produces per-authority alias mappings, conflicts and unresolved entries. Do not resolve every record against the currently selected backend.
2. Add readers for registry, last-project, project preferences/icons, sidebar/workspace settings, tabs, drafts/content/context, prompt history, file tabs, comments and scroll state. Classify authority/window ownership before modifying keys.
3. Resolve known host aliases and build a deterministic remap. Preserve unavailable or ambiguous records in a recovery collection with a repair action; do not silently delete them.
4. Build staged new-schema data with original payload backups, source checksums and a migration version. Preserve draft IDs; keep separate copies of conflicting nonempty drafts.
5. Suspend mutations only for the affected scope. Invalidate old-generation requests and migrate runtime subscriptions/selectors so new readers cannot observe half an alias remap.
6. Commit the remap and active-version marker through P4. Rewrite a legacy URL with replace semantics while preserving its session/draft ID and unsent content.
7. Make journal replay and rerunning the planner idempotent. Publish explicit counts for mapped, merged, retained and conflicted records without logging credentials or content.
8. Retain old payloads and a reverse compatibility/export path for a release cycle. A post-migration rollback must preserve writes created after cutover; it cannot simply point to an obsolete backup.

### Files

Proposed: `packages/app/src/services/workspace-migration.ts`, fixtures and recovery tests. Integration: client persistence, Project Registry, Navigation Coordinator, prompt/file/comment/scroll persistence adapters and directory-route loading.

### Tests

- The exact old tilde-plus-absolute project fixture becomes one canonical project with the same settings and draft IDs.
- Two genuine projects and separate worktrees remain separate.
- A partially completed migration can crash/restart/replay without losing drafts or duplicating tabs.
- An unknown old authority is not guessed from the active server; unavailable cloud/SSH folders remain recoverable.
- A concurrent edit either joins the committed revision through its command or receives a conflict, never disappears.
- An older running window cannot overwrite a newer schema; rollback/export retains content created after migration.

### Gate and Recovery

Run fault-injected fixtures before a live-profile dry run. Enable live migration only after the affected-scope inventory, backup and recovery path are verified. No backend session database rewrite is needed. A migration failure keeps the prior committed version active, surfaces the repair state, and leaves other scopes usable.

## 10. P7 Scoped Session and Draft Ownership

### Work

1. Make existing GlobalSync/session services consume runtime scope and canonical workspace references; do not add a replacement session cache.
2. Convert session, list, SDK-client, file/review, notification and prompt cache keys to the common scoped key builders. Reserve session identity as authority/domain/session ID; a workspace metadata repair is not a new session.
3. Apply runtime generation plus workspace/revision guards to requests, refresh queues and event delivery. Preserve snapshot/event-delta merge behavior and archive/delete tombstones.
4. Bind resource disposal to runtime ownership. Dispose old timers, event streams, queued refreshes and subscriptions exactly once, including same-path backend replacement.
5. Move draft content, context, attachment ordering and draft-to-session promotion into the shared draft/submission owner. Editors retain only DOM selection, focus and rendering synchronization.
6. Implement native host-file and browser-client-file acquisition adapters. Both feed the shared attachment model without confusing a client-local filename with a host path or persisting temporary authorization tokens.
7. Deduplicate local submit intents with a submission ID and draft revision. Audit backend idempotency before enabling network retry; ambiguous failures remain uncertain and reconcile history before resend.
8. Ensure an old submit/restore response cannot erase newer typing, and reading mode/editor remount does not clear the draft. Preserve existing backend durable-session-input behavior rather than replacing it with a frontend retry loop.

### Files

Primary: `packages/app/src/context/global-sync*`, `context/sdk.tsx`, `context/prompt.tsx`, `context/file*`, `context/comments.tsx`, `context/notification.tsx`, `pages/session/review-data-service.ts`, prompt submission/attachment modules and the current editor-sync tests.

Proposed draft/submission facade: `packages/app/src/services/draft-submission.ts`; key builders live with P1 contracts. Use the existing session-service dependency ports for integration.

### Tests and Gate

Same-path/same-session-ID fixtures across two backends remain isolated. Late SSE/list responses cannot resurrect archived sessions. Switching servers/domains and remounting an editor preserves the intended draft. Isolated sidecar message send, persisted assistant reply and permission flow pass through the actual composer. No unproven exactly-once delivery guarantee is introduced.

## 11. P8 Capability Integration and Platform Narrowing

### Work

1. Replace business decisions based only on `remoteMode`, `platform` or method presence with operation capabilities and typed unsupported reasons.
2. Use the same capability selectors for command palette, effective keybind dispatch, rail/context menus, toolbar buttons and service commands. A hidden button and a keyboard action cannot disagree.
3. Review each advertised capability against gateway route policy and backend support. For `/vcs/diff` and similar mismatches, explicitly decide whether the read is supported or unavailable; do not grant routes in bulk.
4. Classify authentication/authorization/capability failures as non-retryable until state changes. Preserve bounded retry for transient transport errors.
5. Separate public provider/model catalog DTOs from credential-bearing administrative configuration. Reuse normalized model selection logic across adapters without exposing hidden host configuration.
6. Migrate restart/reload callers to their explicit operations. Keep native editor launch, shell/terminal management, OS notifications, window controls and responsive layout as intentional adapter/view concerns.
7. Keep old servers behind a documented capability/version compatibility adapter with tests; missing fields never imply unrestricted support.

### Files

`packages/app/src/context/platform.tsx`, entry points, capability/runtime services, command registration, settings/status/model surfaces, project/session menus, and `packages/desktop/src/main/remote/policy.ts` plus gateway contract tests.

### Gate and Recovery

Every enabled remote action has a permitted API contract; unavailable features neither issue requests nor retry indefinitely. Security tests prove credentials, cookies, CSRF and host-only actions stay confined. View-only OS/layout branches remain untouched unless their semantics are being migrated.

## 12. P9 Cleanup and Release Gates

### Work

1. Audit all project writes, workspace key construction, copy handlers and route restoration paths against the P0 checklist. Add an architectural test/lint rule for known raw-path write bypasses rather than banning all platform checks.
2. Remove the old tilde-resolution logic from generic remote fetch only after legacy URL loading and persisted records resolve through the common service.
3. Remove the special remote session-list directory repair only after both the query and visibility selector use the same shared workspace reference.
4. Remove duplicate project setters, module-global coordinator state and stale compatibility methods. Narrow `Platform` to transport/native/view ports with accurate Electron terminology.
5. Run full package tests and builds, then native and remote CDP scenarios on the same fixture set. Repeat reconnect/migration cases using delayed adapters and multiple windows/tabs.
6. Perform a canary upgrade and recovery exercise using isolated profile copies. Keep rollback exports and schema-compatibility checks until the release-cycle retention period ends.

### Gate

No behavior depends on a silent optional-method fallback. No initialization action overrides a later explicit user selection. No raw display path becomes a persistent entity key. No ordinary route/filter/copy operation needs a platform-specific path repair. All migrated state has one writer, and all retained platform differences are documented and tested.

## 13. Suggested Commit Units

These are boundaries for future commits, not an instruction to commit the current working tree wholesale.

| Unit | Scope                                                                 |
| ---- | --------------------------------------------------------------------- |
| C01  | P0 fixture inventory and explicit regressions                         |
| C02  | Runtime/key/error/port contracts and test harness                     |
| C03  | Transport parity and runtime generation lifecycle                     |
| C04  | Shared host-directory implementation and adapter conformance          |
| C05  | Workspace identity service and client provider composition            |
| C06  | Runtime-owned navigation state and delayed-initialization race repair |
| C07  | Browser transactional persistence adapter                             |
| C08  | Main-process desktop persistence transactions and IPC contract        |
| C09  | Shared persistence facade, hydration and conflict tests               |
| C10  | Canonical Project Registry and all admission/copy callers             |
| C11  | Migration dry-run planner, fixtures and staged commit protocol        |
| C12  | Migration integration, recovery and legacy route replacement          |
| C13  | Scoped session/file/review state and subscription disposal            |
| C14  | Draft/submission ownership and attachment adapter integration         |
| C15  | Capability-driven commands/menus and gateway parity                   |
| C16  | Compatibility removal, architectural guards and release evidence      |

Split a unit further if it cannot remain reviewable and independently verified. Never mix unrelated menu appearance, provider snapshots or editor styling into these units.

## 14. Verification Commands and Evidence

Existing commands below are baseline tools, not proof that a future phase is implemented. Add new conformance suites beside the owning services as those services are introduced. Run tests from the relevant package, not the repository root.

From `packages/app`:

```sh
bun run typecheck
bun test --preload ./happydom.ts src/context/global-sync.test.ts src/context/server.test.ts src/context/session-tabs.test.ts src/utils/persist.test.ts src/remote
bun run test:unit
bun run test:virtualizer
```

From `packages/desktop`:

```sh
bun run typecheck
bun test src/main/native.test.ts src/main/remote
```

From the repository root, after confirming that CDP 9222 belongs to development Electron:

```sh
bun packages/desktop/scripts/cdp.ts targets
bun packages/desktop/scripts/build-remote-web.ts
bun packages/desktop/scripts/remote-sessions-cdp.ts '~/apps/opencode' /Users/lelouch/apps
bun packages/desktop/scripts/remote-access-e2e.ts --hold
```

Use the artifacts path printed by the isolated harness:

```sh
bun packages/desktop/scripts/remote-access-cdp.ts <artifacts>/browser-invite.json --no-screenshots
```

Run the directory-picker and reading-mode variants when touching those flows, and the permission fixture when changing transport/capability enforcement. `--no-screenshots` checks DOM/interaction behavior, not visual rendering. Capture and inspect screenshots separately for UI changes.

Public verification is optional and uses only an already-online host:

```sh
bun packages/desktop/scripts/remote-sessions-cdp.ts '~/apps/opencode' /Users/lelouch/apps --public
```

Once P3 ships, that harness must not contain a compensating second project selection. For every frontend phase, the agent runs CDP verification, reads backend logs, and records the selected project, main route, expected session IDs, error/request counts and stale-commit results. For message changes, the agent sends a message and verifies the persisted user/assistant result against an isolated sidecar.

Do not launch a second development Electron without checking existing processes/CDP. Never stop the installed app. Read actual keybind overrides before dispatching shortcuts. Stop only the fixture created for the test and revoke only its temporary QA device. Pushes and GitHub Actions, if later requested, target only `panyw5/opencode`.

### Per Phase Completion Record

| Field               | Required content                                                      |
| ------------------- | --------------------------------------------------------------------- |
| Ownership           | Old owner, new owner, and remaining compatibility facade              |
| Change boundary     | Contracts and exact migrated callers; unsupported cases               |
| State compatibility | Schema version, remapping, backups and rollback/export path           |
| Verification        | Commands, fixture IDs/paths, actual pass/fail counts and CDP evidence |
| Security            | Effective capability/route checks and credential isolation            |
| Open risks          | Explicit blockers or unverified operating-system/host combinations    |
| Next phase          | Satisfied dependencies and retained compatibility logic               |

No phase is complete on typechecking alone. If a required runtime or platform is unavailable, mark its gate unverified and do not remove the associated compatibility path.

## 15. Execution Record: 2026-11-01

### First Change Boundary

This batch implements the C01 synthetic fixture/checklist foundation, C02 contract types/key builders and the D6 request-override correction from C03. It does **not** complete P1 composition, runtime generation disposal, identity resolution, navigation ownership or persistence migration. The P0 broad-suite gate remains open because existing full-suite failures were found below. No commit, push or GitHub Action was run.

- `services/contracts.ts` defines authority/runtime/workspace/window types, stable authority sources, tuple-encoded session/workspace/draft keys, typed errors, capability intersection and directory/lifecycle ports. These are contracts, not a second mutable state owner. Existing stores do not yet use the new keys.
- Managed identity explicitly requires a profile and saved connection/distro; it cannot contain a sidecar endpoint port. Unmanaged loopback HTTP endpoints stay separate. HTTP identity excludes credentials, query and fragment, while retaining the endpoint origin and path. Query-routed hosts need a verified saved identity before adoption.
- `services/test-utils/runtime-fixtures.ts` returns fresh synthetic legacy records for tilde/canonical aliases, their distinct parent project, conflicting preferences, tabs, draft content/context, directory caches and identical session IDs on two backends. `deferredPort` releases or fails operations explicitly, without sleeps.
- `services/transport.ts` is used by desktop renderer fetch and remote bootstrap. `new Request(input, init)` applies method/header/body/signal overrides once. Aborted legacy directory consumers cannot dispatch a subsequent host request; another consumer of the same lookup remains usable. HTTP failures and streaming responses are not converted or pre-consumed.
- `remote-sessions-cdp.ts` now records the route before/after selection, first-selection preservation, expected and visible session IDs, selected projects, errors and failed/unresolved requests. It rejects rows from another project's response. `--strict-selection` never performs a compensating second click; default P0 compatibility recovery is explicitly logged until P3 removes it.

### Ownership and Compatibility

| Field               | This Batch                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership           | Server, GlobalSDK, GlobalSync, Layout, Prompt and SessionTabs retain their existing state ownership. Only request construction moves from platform-specific branches to a shared function.                                    |
| Migrated callers    | Desktop `createPlatform().fetch` and Web `createRemoteFetch`. External desktop IPC fetch and SSE fetch selection remain unchanged.                                                                                            |
| State compatibility | No schema change, remap, profile write or backend database migration. Existing remote tilde/session-list repairs remain enabled. Rollback is code-only.                                                                       |
| Security            | Gateway allowlist, cookie/CSRF handling and native authorization are unchanged. Transport logs contain method/stage only, not URLs, credentials, bodies or draft content. Capability contracts grant no live permissions yet. |
| Open risks          | P0 full-suite gate; timing-dependent sidebar restoration; P1 runtime composition/generation/stream lifecycle; capability compatibility manifest; Windows and SSH/WSL conformance.                                             |
| Next phase          | Finish P1 composition and generation/stream lifecycle against the existing GlobalSDK owner, then P2 host directory adapters and P3 coordinator ordering. Do not begin durable P5/P6 writes before P4.                         |

### Initial Working Tree Inventory

Baseline HEAD: `576cb017ec94aeea507c0d1cbcb051747e388ca0`. The following work was already present and was not reverted or included wholesale:

| Group                                 | Existing Files (Relative to `packages/`)                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote directory/session-list repairs | `app/src/components/dialog-select-directory.tsx`, `app/src/context/global-sync.test.ts`, `app/src/context/global-sync.tsx`, `app/src/context/global-sync/session-load.ts`, `app/src/context/global-sync/types.ts`                                                                                                                                           |
| Composer/editor work                  | `app/src/components/prompt-input.tsx`, `app/src/components/prompt-input/sync.ts`, `app/test-browser/prompt-editor-sync.test.ts`                                                                                                                                                                                                                             |
| Menu/provider appearance              | `app/src/pages/config-channels.tsx`, `app/src/pages/config-create-menu.css`, `app/src/pages/config-provider-list-shared.tsx`, `app/src/pages/config-provider-list.css`, `app/src/pages/config-section-button.tsx`, `app/src/pages/config.tsx`, `app/src/responsive-web.css`                                                                                 |
| Remote harness/policy work            | `desktop/docs/remote-access.md`, `desktop/scripts/remote-access-cdp.ts`, `desktop/scripts/remote-access-e2e.ts`, `desktop/scripts/remote-sessions-cdp.ts`, `desktop/scripts/remote-menu-cdp.ts`, `desktop/src/main/remote/gateway.test.ts`, `desktop/src/main/remote/policy.ts`                                                                             |
| Backend/tool work                     | `opencode/src/project/location-lifecycle.ts`, `opencode/src/provider/models-snapshot.js`, `opencode/src/session/session.ts`, `opencode/src/tool/registry.ts`, `opencode/src/tool/session_create.ts`, `opencode/src/tool/session_create.txt`                                                                                                                 |
| Backend tests                         | `opencode/test/im/dispatcher.test.ts`, `opencode/test/session/prompt.test.ts`, `opencode/test/session/snapshot-tool-race.test.ts`, `opencode/test/session/structured-output-integration.test.ts`, `opencode/test/tool/registry.test.ts`, `opencode/test/tool/skill.test.ts`, `opencode/test/tool/task.test.ts`, `opencode/test/tool/session_create.test.ts` |
| Specifications                        | Both client-runtime specification and plan files were untracked at the start.                                                                                                                                                                                                                                                                               |

Only the sidebar harness above received additional changes in this batch. Later unrelated appearance changes, including `config-surfaces.css`, were left alone. No stash/reset was used.

### Entry-Point Checklist

This is an inventory of remaining migration work, not a claim these callers already use the new contracts. All paths below are under `packages/app/src/` unless noted.

| Entry Point                                   | Current Boundary                                                                                                    | Required Owner / Phase                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Home manual input                             | `pages/home-path-input.tsx` -> `pages/home.tsx:openProject`                                                         | Strict host resolution P2; registry admission P5                          |
| Directory dialog                              | `components/dialog-select-directory.tsx`                                                                            | Strict port result P2; no optional-method success fallback P5             |
| Native picker                                 | `pages/home.tsx:chooseProject`, `pages/layout.tsx`, desktop renderer picker adapters                                | Native acquisition only; common resolver/admission P2/P5                  |
| Drag/drop                                     | `pages/layout.tsx` drag-drop handler; desktop `main/native.ts` filter                                               | Distinguish unresolved drop retention from strict admission P2/P5         |
| Deep links                                    | `pages/layout.tsx` deep-link handler                                                                                | Resolve owning authority and preserve session/draft intent P3/P5/P6       |
| Recent sessions                               | `pages/home.tsx` recent-session activation                                                                          | Scoped session lookup and explicit navigation P3/P7                       |
| Project tasks                                 | `pages/home.tsx:openProjectTask`, `pages/layout.tsx` task handlers                                                  | Canonical registry references and navigation P3/P5                        |
| Project rail/context actions                  | `pages/layout.tsx:openProject`, `pages/layout/sidebar-project.tsx`                                                  | Separate preview from conversation route P3; single registry writer P5    |
| Tab restoration                               | `context/layout.tsx`, `context/session-tabs.tsx`                                                                    | Window-local intent ordering P3; transactional remapping P4/P6            |
| Copy path                                     | `components/session/session-header.tsx`, `components/session/session-new-view.tsx`, `pages/layout.tsx` sidebar copy | Canonical identity selector, never display path P2/P5                     |
| Session metadata repair                       | `context/global-sync/session-load.ts`, `context/session-tabs.tsx`                                                   | Preserve list delta reconciliation P7 and existing compatibility until P9 |
| Retained drafts/history/files/comments/scroll | `context/prompt.tsx`, `context/layout.tsx`, persistence consumers                                                   | Inventory all readers before P6; scoped documents P7                      |

### Verification Evidence

Commands ran from the owning package except CDP/build harnesses. Development Electron was already running at `http://localhost:5173/index.html` on CDP 9222; no second Electron or installed app was launched/stopped. No keybinds were dispatched.

| Check                                           | Result                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-edit targeted app baseline                  | 97 pass, 0 fail across GlobalSync/Server/SessionTabs/Persist/remote suites                                                                                                                                                                                                                                                                                       |
| Pre-edit native/gateway baseline                | 57 pass, 0 fail                                                                                                                                                                                                                                                                                                                                                  |
| Targeted app suites plus new contracts/fixtures | 105 pass, 0 fail                                                                                                                                                                                                                                                                                                                                                 |
| Native Fetch adapter conformance                | 12 pass, 0 fail in `desktop/src/renderer/transport.test.ts`; both desktop and HTTP adapters run the same cases                                                                                                                                                                                                                                                   |
| Native/gateway plus transport conformance       | 69 pass, 0 fail                                                                                                                                                                                                                                                                                                                                                  |
| App browser/virtualizer tests                   | 42 pass, 0 fail                                                                                                                                                                                                                                                                                                                                                  |
| App and desktop typecheck                       | Both pass                                                                                                                                                                                                                                                                                                                                                        |
| Remote Web production bundle                    | Pass; existing large-chunk/static-dynamic import warnings remain                                                                                                                                                                                                                                                                                                 |
| Full app unit suite                             | 1805 pass, 3 fail; phase gate is NOT green                                                                                                                                                                                                                                                                                                                       |
| Isolated rerun of full-suite failures           | `utils/prompt.test.ts` non-injection preview assertion and `session-render-state.test.ts` deadline reference-equality assertion still fail; timeline `rows.test.ts` passes alone. Its full-suite failure is a `useData` export/mock interaction. These files and their implementation files have no working-tree diff from HEAD. No unrelated fix was attempted. |
| Electron CDP Fetch probe                        | Shared production transport imported into the dev renderer; PATCH/body/header overrides passed, already-aborted request rejected, exactly one fake dispatch. No network write or profile mutation.                                                                                                                                                               |
| Read-only remote cross-project list             | Legacy `~/apps/opencode` on route `/Users/lelouch/apps`: 10 visible IDs all in the 100 expected roots; route unchanged; errors=0, failed requests=0, unresolved requests=0. Host resolution and list visibility repair logs both observed.                                                                                                                       |
| P3 strict selection baseline                    | Explicitly failed with `P3 regression: initialization overwrote explicit sidebar selection`; a later strict rerun passed. This is a timing-dependent known failure, not a P3 fix or a green ordering gate.                                                                                                                                                       |
| Isolated sidecar + real remote composer         | `remote-access-e2e.ts --hold` then `remote-access-cdp.ts <fixture>/browser-invite.json --no-screenshots`: PASS. Harness sent a message and verified a persisted assistant response; CDP typed/submitted through the actual inline composer and verified another persisted reply. Mobile auth and session history both reported errors=0 and failedRequests=0.    |

The Fetch conformance suite intentionally runs in the desktop package's native Fetch environment: Happy DOM 20.0.11 incorrectly retains the input body for `new Request(request, { body: replacement })`. Electron's real browser implementation was checked independently over CDP; production behavior was not changed to accommodate the mock.

Isolated message fixture: `/private/tmp/codeg-acp-501/94974-874722a8/opencode-remote-e2e-OaM5WV`, session `ses_ffe5e689be64affesB9oPaNbqn`. Gateway/sidecar logs were read by the agent. After harness shutdown, a read-only SQLite query confirmed two user messages and two assistant messages, with both replies equal to `REMOTE_ACCESS_SIDECAR_OK`. The temporary QA views and this harness's own sidecar were cleaned up; development Electron remained running. Screenshots were skipped because this batch changes transport/contracts, not presentation. Permission-specific, Windows and SSH/WSL gates remain unverified.

## 16. Public Remote Loading Regression: 2026-11-01

The user's restarted development host still reproduced a stuck `opencode` sidebar at the bare `/Users/lelouch/apps` project route. The earlier loopback/session-route test was insufficient evidence of public-host recovery.

### Observed Failure

- Read the restarted host's `remote.log`, `server.log` and `renderer.log` under `~/Library/Application Support/ai.opencode.desktop.dev/logs/20261101T143523/`.
- Reproduced through a temporary authenticated QA browser on the already-online public host. Its legacy directory validation took about 78 seconds; several other small requests queued for over 90 seconds. The session module download failed, disposing the application while its list load was still pending. The 30-second root-list timeout subsequently logged a discarded result against that disposed owner.
- The gateway served a 3,249,772-byte main script, 908,257-byte session module and 5,752,995-byte redacted model catalog without transport compression. These large concurrent downloads amplify the public transport delay; loopback did not expose it. No claim is made that compression fixes every tunnel/network failure.
- The root-route harness also independently reproduced delayed initialization restoring the route project's sidebar selection after a user previewed another project.

### Changes

- Added gzip negotiation for public text assets and already-redacted configuration/catalog JSON. Preserve `Vary`, cache/security headers and HEAD semantics; never compress authentication responses or SSE. Measured main script: 927,157 bytes; session module: 273,021 bytes; redacted catalog: 353,970 bytes. Gateway policy, redaction and upload/decompression limits are unchanged.
- Root-list timeout now aborts its request signal, passes it through SDK resolution/list calls and rejects a late resolver before another request can start. Remote alias lookup has its own bounded timeout; canceling one consumer rejects promptly without canceling another consumer's shared lookup. Silent load failures surface their error in the sidebar instead of appearing as an unexplained empty result.
- The existing layout route-reconciliation flag now carries the sidebar command revision and observes the project index before lazy session/draft mounting. Older initialization cannot overwrite a newer explicit selection. Genuine session-ID navigation still reconciles to its route project. This is a targeted race repair, not completion of P3's runtime-owned coordinator extraction.
- The CDP harness now supports `--project-index`, `--open-session` and `--delay-project-metadata`. The delayed case releases metadata only after the first explicit selection. Removed the compensating second selection entirely. The bare project's existing same-workspace initial-draft redirect is explicitly distinguished from preview-induced cross-project navigation.

### Verification and Deployment Boundary

| Check                                               | Result                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App targeted foundation/remote tests                | 107 pass, 0 fail                                                                                                                                                                                          |
| SessionTabs and layout helpers                      | 119 pass, 0 fail                                                                                                                                                                                          |
| Desktop native/gateway/transport/encoding tests     | 71 pass, 0 fail                                                                                                                                                                                           |
| Browser/virtualizer tests                           | 42 pass, 0 fail                                                                                                                                                                                           |
| App and desktop typechecks                          | Pass                                                                                                                                                                                                      |
| Remote frontend bundle                              | Pass                                                                                                                                                                                                      |
| Strict project-index CDP                            | Pass: first selection preserved, 10 visible rows belong to the expected 100 roots, existing conversation opened, errors=0 and failed requests=0                                                           |
| Deterministic delayed-metadata project-index CDP    | Pass without second click; log `/tmp/opencode-delayed-project-index-cdp.log`                                                                                                                              |
| Strict session-route CDP                            | Pass without second click; log `/tmp/opencode-session-route-cdp.log`                                                                                                                                      |
| Actual isolated remote composer and permission flow | Pass: typed/submitted, approved harmless printf through the real session-scoped permission route, verified persisted tool output and assistant reply                                                      |
| Sidecar database/log verification                   | Fixture `opencode-remote-e2e-Lcttrn`, session `ses_ffe5e685f8b48ffe7NHXWv0yLd`: 2 user messages, 4 assistant steps, 2 final `REMOTE_ACCESS_SIDECAR_OK` replies; backend logs read by the agent            |
| Full desktop package build                          | Not verified: prebuild dependency install hit sandbox temp permission limits; direct full Electron build lacks `packages/opencode/dist/node/node.js`. No dependency or lockfile workaround was installed. |
| Standalone remote worker bundle                     | Built from current source using Vite SSR with the existing tunnel/Effect dependencies bundled; `node --check` passed. Other main-process outputs were not deleted or replaced.                            |
| Current public worker rollout                       | Pending permission to briefly restart the remote connection. Existing public worker is still the old process; public end-to-end recovery is NOT yet signed off.                                           |

Only the QA device named `Remote loading QA` was revoked, and its temporary browser was closed. The isolated fixture sidecar was stopped and its logs flushed. The user's paired device, installed app, development Electron and active public connection were left intact. No user session was submitted to or rewritten; all message sends used the isolated fixture.

This targeted bug batch does not complete P1/P2/P3 ownership migration or enable P4-P6 persistent migration. The full-unit-suite failures recorded in section 15 remain a separate open gate.
