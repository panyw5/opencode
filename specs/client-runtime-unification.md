# Shared Client Runtime Services

Status: design proposal, not an implemented refactor.

Execution sequence and phase gates: [Shared Client Runtime Implementation Plan](./client-runtime-unification-plan.md).

Audit date: 2026-11-01. Baseline: `576cb017ec` plus the current working tree, including the uncommitted cross-project remote session-list repair. Existing unrelated edits must remain intact.

## 1. Scope and Decisions

Electron and Web already share the application and session domain. The architectural gap is that platform adapters also implement business rules, while several shared contexts retain independently keyed copies of project and workspace state.

The target is one implementation of domain rules per client runtime, with transport and presentation adapters at the edges. It is not a single global mutable store, automatic synchronization of desktop and browser preferences, or a rewrite of the backend session engine.

Decisions:

- Canonical workspace references enter domain services; raw paths enter only identity resolution and legacy migration boundaries.
- Each state collection has one owner and an explicit connection scope.
- Existing session data services, path utilities, and tab coordination are extended rather than duplicated.
- Native capabilities and remote authorization remain distinct. A shared interface does not grant a browser native host privileges.
- Compatibility behavior remains until every entry point and persisted reference has migrated successfully.
- Changes ship incrementally, with the same domain contract tests against each supported adapter.

## 2. What Is Already Shared

| Area                           | Current implementation                                                                                                                                   | Reuse decision                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Application composition        | Both entry points mount `AppBaseProviders` and `AppInterface`; `packages/app/src/app.tsx` mounts the same server, SDK, sync, layout, and route hierarchy | Preserve this composition                                                  |
| Projects and sidebar           | `context/server.tsx`, `context/layout.tsx`, `pages/layout.tsx`, `pages/layout/sidebar-*.tsx`                                                             | Extract ownership and orchestration, not a second sidebar                  |
| Session data                   | `context/global-sync.tsx`, `context/global-sync/session-service.ts`, info/messages/status/todo/diff/history services                                     | Keep the repository and existing request/event reconciliation              |
| Tab lifecycle                  | `context/session-tabs.tsx`                                                                                                                               | Extend the coordinator; do not introduce competing navigation intent state |
| Draft content and editing      | `context/prompt.tsx`, `components/prompt-input*`                                                                                                         | Keep one draft model; make editor mounting a view concern                  |
| Models and configuration views | Shared contexts and components consume SDK data                                                                                                          | Share normalized public model semantics, not provider secrets              |
| Files and review data          | `context/file*`, `pages/session/review-data-service.ts`                                                                                                  | Reuse their request coalescing, isolation, and reconciliation              |
| Persistence facade             | `utils/persist.ts` already selects desktop storage or browser storage                                                                                    | Strengthen its transaction and scope contract                              |
| Path primitives                | `packages/core/src/util/path.ts`, workspace helpers                                                                                                      | Reuse logical/native/identity distinctions                                 |

### Necessary Differences

| Boundary             | Electron                                                            | Remote Web                                           | Must remain different                     |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Host access          | Main process and preload IPC; selected backend may also be SSH/WSL  | Authenticated gateway requests to the selected host  | Authority and transport                   |
| Directory picking    | Native picker, native drops, SSH/WSL adapters                       | Host-backed browsing UI                              | Input mechanism, not resolution semantics |
| Credentials          | Local sidecar authentication and desktop-managed server credentials | HttpOnly device cookie, exact-Origin and CSRF checks | Credential handling                       |
| Available operations | Native editors, OS notifications, terminal, host management         | Restricted session workflow and permitted host reads | Capability and authorization policy       |
| Local preferences    | Desktop profile storage through IPC                                 | Origin-scoped browser storage                        | Storage medium and profile ownership      |
| Navigation shell     | Desktop memory router and window/deep-link integration              | Browser URL and history                              | Router adapter                            |
| Layout               | Desktop window controls and native surfaces                         | Responsive layout, keyboard viewport and safe areas  | Presentation                              |

These differences must not change workspace identity, session ownership, draft promotion, stale-response rejection, or the meaning of a successful project-open command.

## 3. Divergence Audit

Paths below are relative to `packages/` unless otherwise specified. A confirmed code difference is not automatically a reproduced data-loss incident.

| ID  | Finding and evidence                                                                                                                                                                                                                                                                                                                                                                                                                | Classification                                                                                                                                         | Target owner                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| D1  | `app/src/context/server.tsx` persists `StoredProject.worktree` as a raw string. `app/src/pages/layout/sidebar-project.tsx` copies that value. The remote fetch repair canonicalizes requests, and the session-list repair updates a child store, but neither migrates the registry, tabs, or all cache keys                                                                                                                         | Confirmed inconsistency and reproduced empty-list cause                                                                                                | Workspace Identity and Project Registry            |
| D2  | `desktop/src/main/native.ts:filterDirectories` expands home and follows `realpath`, but retains paths when `stat` fails through `keepDroppedPathAsDirectory`. `desktop/src/main/remote/directory.ts` requires an existing directory, rejects relative input, and reports failure. `app/src/components/dialog-select-directory.tsx` and `pages/home-path-input.tsx` can bypass validation when an optional platform method is absent | Confirmed contract differences; permissive native drop behavior is intentional in its existing test, not permission to silently validate a new project | Host Directory port and shared identity service    |
| D3  | `app/src/pages/layout.tsx` has pending route-to-sidebar reconciliation, fallback effects, explicit project selection, and session-open restoration. User selection invalidates tab navigation but does not own all of those writes. Earlier public CDP checks observed initialization restoring the route project after a preview selection                                                                                         | Reproduced ordering race; slower remote startup exposes it more often                                                                                  | Navigation Coordinator                             |
| D4  | `app/src/context/global-sync.tsx` keys directory maps from workspace paths, with domain managers and SDK versions providing some isolation. `context/prompt.tsx` keys draft cache entries by path and session/draft ID. `context/layout.tsx:sessionBarKey` uses session ID alone. Identical paths or copied session IDs on different backends need an explicit authority namespace                                                  | Isolation risk, not a newly reproduced cross-host corruption                                                                                           | Connection Runtime and scoped entity keys          |
| D5  | `app/src/context/session-tabs.tsx` keeps navigation intent, close handoff, tombstones, and reconcile/workspace epochs in module-level mutable state                                                                                                                                                                                                                                                                                 | Ownership/lifecycle risk across coordinators and connection changes                                                                                    | Runtime-scoped Navigation Coordinator              |
| D6  | Desktop `renderer/index.tsx:fetch` ignores `init` when `input` is already a `Request`; Web `remote/bootstrap.ts` constructs `new Request(input, init)`. Global SDK selects its SSE fetch through a separate protocol/loopback branch                                                                                                                                                                                                | Confirmed adapter semantics differ; standard request override behavior needs parity tests                                                              | Connection Transport                               |
| D7  | `app/src/context/platform.tsx` is a large collection of optional methods. `remoteMode`, `platform`, and `server.isLocal()` checks are distributed through pages, components, and contexts. The remote session advertises only a small capability set; gateway route policy separately restricts operations                                                                                                                          | Confirmed decentralized policy; hidden UI is not an authorization boundary                                                                             | Runtime Capabilities                               |
| D8  | `app/src/context/layout.tsx:projects.open` combines local registry writes and fire-and-forget backend registration. The current remote repair skips a host-only route, rather than giving the shared operation one explicit result contract                                                                                                                                                                                         | Confirmed mixed responsibilities                                                                                                                       | Project Registry; optional host discovery command  |
| D9  | `app/src/utils/persist.ts` exposes sync browser and async IPC storage through the same facade and ready flag. The inspected project/layout persistence paths do not define cross-record transactions or cross-tab compare-and-swap coordination                                                                                                                                                                                     | Persistence contract gap; no claim of newly reproduced lost writes                                                                                     | Client Persistence                                 |
| D10 | `Platform.restart` reloads the browser page on Web, but kills the sidecar and relaunches the application on desktop                                                                                                                                                                                                                                                                                                                 | Intentional implementation difference with an ambiguous operation name                                                                                 | Separate reload-client and restart-host commands   |
| D11 | File attachment acquisition differs between native paths, picked-file authorization tokens, browser `File` objects, and gateway requests. Prompt state and editor DOM lifetimes also differ during reading mode and compact layouts                                                                                                                                                                                                 | Necessary acquisition differences; shared draft and submission invariants are still required                                                           | Draft and Submission service plus attachment ports |
| D12 | The remote gateway deliberately redacts configuration/model responses and denies host administration. For example, the current client review path can request `/vcs/diff` while the gateway policy lacks it                                                                                                                                                                                                                         | Confirmed capability/route mismatch; whether to permit or disable a feature is a policy decision, not a reason to widen the allowlist wholesale        | Capability manifest and feature contracts          |

Priorities: D1-D5 first, because identity and competing writers affect correctness. D6-D12 follow through the same capability and transport foundation. Cosmetic platform branches are not inherently defects.

## 4. Target Service Graph

```text
Electron shell / Web shell / SSH and WSL connection adapters
  -> ClientPorts: host transport, directory port, storage, router, native shell
  -> ConnectionRuntime + effective capabilities
  -> WorkspaceIdentity
  -> ProjectRegistry / SessionRepository / DraftSubmission
  -> NavigationCoordinator
  -> read-only selectors and shared UI commands
```

| Service                | Authoritative state and commands                                                                                                         | Existing code to preserve or absorb                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Connection Runtime     | Selected authority, domain, connection generation, host filesystem metadata, effective capabilities, HTTP/SSE lifecycle                  | `context/server.tsx`, `context/global-sdk.tsx`                           |
| Workspace Identity     | Canonical workspace records, raw-path aliases, unresolved legacy records, identity resolution flights                                    | Core path utilities, workspace helpers, host directory adapters          |
| Project Registry       | Open project membership/order, project-to-workspace relationships, project preferences, last project, open/close/rename/migrate commands | Project-related portions of server/layout contexts                       |
| Session Repository     | Scoped session entities, root lists, list-request deltas, messages, status, todo, diffs and history                                      | Existing GlobalSync/session services; not a replacement cache            |
| Navigation Coordinator | Active route/tab, preview sidebar project, intent epochs, close handoff and lifecycle tombstones                                         | Existing SessionTabs coordinator plus scattered layout orchestration     |
| Draft and Submission   | Draft content/revision, attachments/context, draft-to-session mapping and pending/uncertain submission state                             | Prompt context, submit orchestration, existing server admission behavior |
| Client Persistence     | Hydration, schema versions, serialized mutations, migration journal, profile/window/tab ownership and durable-write results              | `utils/persist.ts` and IPC/browser storage adapters                      |

Capability policy belongs to Connection Runtime, not an additional state store. Native shell actions remain ports. Layout owns visual geometry, not project identity or navigation intent.

## 5. Identity and Port Contracts

### Distinct Values

| Value                       | Use                                                                                | Never use it for                                  |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| Raw directory input         | Picker, URL recovery, migration input                                              | Registry/cache writes                             |
| Canonical logical directory | Host-confirmed absolute, case-preserving path for APIs, copying and route encoding | Display abbreviation or generic lowercasing       |
| Workspace ID                | Opaque identity scoped to the selected authority                                   | Filesystem reads or shell commands                |
| Display path                | Home-abbreviated text such as `~/apps/opencode`                                    | API requests, clipboard path output or state keys |
| Route slug                  | Encoded canonical logical directory for current compatible URLs                    | Filesystem identity or repeated decoding          |

`/Users/lelouch/apps` and `/Users/lelouch/apps/opencode` are different workspaces. Two worktrees may share a backend project ID without sharing workspace identity. Merge only host-confirmed aliases, never parent/child prefixes or matching repository IDs.

The filesystem belongs to the selected host, not the browser or Electron client OS. Remote platform metadata must be explicit. Unknown hosts must not cause speculative case-folding. Virtual extra-agent workspaces use an opaque identity path, not host `realpath`.

Proposed interface shape, not current API:

```ts
type AuthorityKey = string & { readonly authority: unique symbol }
type WorkspaceID = string & { readonly workspace: unique symbol }
type SessionKey = string & { readonly session: unique symbol }

type RuntimeScope = {
  authority: AuthorityKey
  domain: string
  generation: number
}

type WorkspaceRef = {
  authority: AuthorityKey
  id: WorkspaceID
  kind: "filesystem" | "virtual"
  directory: string
  filesystem: "posix" | "windows" | "opaque"
}

interface WorkspaceIdentity {
  resolve(scope: RuntimeScope, input: string, signal?: AbortSignal): Promise<WorkspaceRef>
  get(scope: RuntimeScope, id: WorkspaceID): WorkspaceRef | undefined
  display(ref: WorkspaceRef): string
  copyPath(ref: WorkspaceRef): string
}

interface ProjectRegistry {
  open(ref: WorkspaceRef): Promise<void>
  close(ref: WorkspaceRef): Promise<void>
}
```

Authority is stable connection/profile identity, not an ephemeral sidecar port, arbitrary current URL, or authentication token. Initially adapt existing connection keys with explicit profile/endpoint namespaces. Do not merge every loopback server into one authority. If a future stable backend ID links multiple endpoints, link them only through a verified handshake; do not infer shared identity from filesystem paths.

Session entity keys are `(authority, domain, sessionID)`. Directory query keys additionally include workspace ID. Session metadata may repair a workspace association without creating a duplicate tab for the same scoped session. Connection generation invalidates in-flight work but is not a new persistent workspace identity.

For the first implementation, derive filesystem workspace IDs from the host-confirmed canonical path through the existing `Path.identity` contract; serialize composite keys as tuples rather than concatenating unescaped path strings. Keep the original canonical logical spelling alongside the identity. A verified stable backend location ID may replace this derivation later without changing consumers. Virtual workspace IDs come from their owning integration. No new database identity scheme is required in the first stage.

Managed sidecars use profile-scoped stable connection identity across port changes. Standalone loopback endpoints remain distinct unless explicitly linked. SSH and WSL use their saved connection/distro identities, not a local filesystem flag. Without verified backend linkage, a new tunnel origin remains a separate client authority; this is safer than silently attaching old records to a different host.

### Host Directory Contract

Share server-side resolution code between native IPC and gateway handlers, using a server-only module such as `packages/util/src/host-directory.ts`. Never bundle Node filesystem access into browser services.

Normal project selection requires an existing directory and returns its canonical logical path. Input validation, home expansion, `realpath`, path encoding and typed error codes follow one contract. Relative paths require an explicit host-side base; remote clients do not inherit an implicit browser/current-process working directory.

Offline/native-drop retention is a separately named operation that returns an unresolved reference. It must not report strict validation success. A listing failure is not a successful empty listing. Listing and validation do not require full model/provider bootstrap.

Use stable domain error codes such as `unsupported`, `not-found`, `not-directory`, `forbidden`, `unavailable`, `stale-scope`, and `conflict`. IPC and HTTP adapters translate their errors to those codes; components translate codes into messages. HTTP authentication failure is not translated into an empty directory or a successful project-open result.

Native allowed-root registration and gateway device authorization remain outside the shared resolver. SSH/WSL adapters execute against the selected filesystem and must not expand its `~` on the desktop host. Unsupported directory resolution returns an explicit unsupported result; the UI cannot fall through to registering a raw string.

### Effective Capabilities

Expose operation-level capabilities, including read/write distinctions and a reason when unavailable. Effective capability is the intersection of backend support, transport support, authorization policy, and native-shell availability.

Directory resolution, session reads/sends, permission replies, file reads, VCS reads, terminal access, host administration and local editor launch must not be inferred from one `isDesktop` boolean. Old servers lacking a manifest use an explicit conservative compatibility adapter, not blanket capability grants.

UI commands, keyboard commands, menus and services use the same capability selector. The gateway still independently enforces authorization, CSRF, Origin, redaction and size limits. Catalog metadata can be shared; credential-bearing administrative configuration cannot.

## 6. State Ownership and Concurrency

### Single Writers

| State                                        | Only writer                | Lifetime                                                          |
| -------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| Workspace identity and aliases               | Workspace Identity         | Authority-scoped runtime plus persisted registry                  |
| Open projects and order                      | Project Registry commands  | Client profile/authority; synchronized across its windows/tabs    |
| Session data and event application           | Session Repository         | Runtime/authority/domain; backend remains durable source of truth |
| Active route, active tab and sidebar preview | Navigation Coordinator     | Window/tab; not forcibly shared across devices                    |
| Draft content and context                    | Draft service              | Scoped draft/session; persisted separately from editor DOM        |
| Editor selection and DOM focus               | Editor view adapter        | Mounted editor only                                               |
| Dimensions and compact layout                | Layout/view state          | Window/tab                                                        |
| Authentication secrets                       | Transport/security adapter | Credential storage or HttpOnly cookie, never workspace metadata   |

Components dispatch commands and consume selectors. They do not directly call project storage setters, invent workspace keys, repair route ownership in effects, or overwrite canonical state from display strings.

### Request Rules

- Every asynchronous commit checks runtime generation, workspace identity and the operation's revision. Abort is cleanup, not proof that a response cannot commit.
- Resolve aliases single-flight within `(authority, generation, raw input, explicit base, mode)`. Bound successful caches, invalidate them on lifecycle changes, and retry failures. A symlink resolution must not be an eternal assertion after the filesystem changes.
- Shared requests have consumer cancellation distinct from runtime cancellation. One unmounted consumer must not cancel every subscriber's load.
- Preserve existing session-list snapshot/event-delta merging and revision guards. Do not replace them with last-response-wins or a global lock.
- Background refreshes cannot clear a newer foreground result. Capability-denied/authentication failures are terminal until capability/auth changes; transient transport errors use bounded retry/backoff.
- Standardize `Request` plus `RequestInit` merging, abort signals and body handling in every transport. SSE has an explicit streaming transport port, not an unrelated fetch-selection branch.

### Navigation Intents

Keep route workspace, active conversation workspace and sidebar preview workspace distinct. Selecting a sidebar project must not implicitly create a draft or navigate away from the current conversation.

Extend the existing tab coordinator with a window-scoped intent ledger. Initial route restoration captures the selection epoch it started with. A later explicit project selection invalidates that restoration, even if project metadata arrives later. An explicit subsequent session navigation or browser Back action may deliberately select its own route project.

Move module-level coordinator state into the coordinator/runtime owner. Scope tombstones, close handoffs and reconcile epochs by authority/domain. Preserve existing close-neighbor, parent/child and draft-promotion semantics.

The public regression harness currently reselects a project after initialization restores the route project. Remove that recovery once the coordinator owns ordering: the test must fail if initialization overrides the first explicit selection.

### Drafts and Submissions

Preserve draft ID, content, context and attachment order when resolving a legacy workspace alias. Unmounting an editor, entering reading mode, or changing a compact layout never clears the draft.

Attachment ports produce explicitly different inputs for a host file reference and a client-owned browser file. The shared service owns metadata validation, ordering, removal and submission representation; acquisition/authorized reading remains adapter-specific. Do not interpret a browser-local path as a file on the remote host or persist native picked-file authorization tokens as durable attachments.

Draft promotion is one coordinated operation: associate the backend session, update the tab and route, and retain content until submission acknowledgment/reconciliation. A response for an older draft revision cannot reset newer typing.

Deduplicate local submit intents by submission ID. Do not claim exactly-once network delivery from a frontend mutex: automatic retries of ambiguous writes require backend-supported idempotency. Otherwise record an uncertain submission and reconcile history before allowing a resend. Existing durable backend admission contracts remain authoritative.

## 7. Persistence and Legacy Migration

Use an asynchronous storage contract for both browser and IPC adapters, with explicit hydration and write results. This standardizes ordering, not storage location. Do not move backend session data into client persistence or automatically synchronize desktop/browser preferences.

Critical persisted records require a revisioned update/transaction protocol. Desktop multi-window updates must serialize and check revisions in the main-process storage service. Browser multi-tab updates require an actual atomic mechanism, such as IndexedDB transactions or a single-writer design with fencing; BroadcastChannel alone is notification, not mutual exclusion. If a storage backend cannot provide those guarantees, expose a constrained single-writer mode rather than pretending plain localStorage is transactional.

Migration is authority-scoped and resumable:

1. Hydrate the relevant records, preserve the old payloads, and create a migration journal/version. Queue new mutations for that scope until it is ready; do not block unrelated workspaces on provider catalogs.
2. Resolve legacy path aliases on the owning host. Keep unavailable and ambiguous records visible as unresolved; do not delete them or assign every old tab to whichever server is currently selected.
3. Build one remapping plan covering project membership/order, last project, project metadata/icons, sidebar/workspace preferences, open tabs, drafts and their content/context, prompt history, file tabs, comments, scroll state and cache subscriptions.
4. Merge only verified aliases. Preserve draft IDs and separate conflicting nonempty drafts instead of applying last-write-wins. Retain per-field project preferences and stable order. Archived/deleted backend session state is not resurrected by local migration.
5. Invalidate old in-flight work, stage the new version, publish the remap to runtime consumers as one logical commit, and switch the durable active-version marker only after all dependent writes succeed.
6. Replace a legacy route with its canonical path while preserving the session/draft ID. Do not create a replacement draft as a side effect of rewriting a URL.
7. Retain rollback data for a release cycle. Re-running or recovering the migration is idempotent. No backend session table rewrite is required.

When records span stores/files, use an explicit journal and commit marker or a real storage transaction. Do not call several independent `setItem` operations an atomic migration. New readers must consistently honor the committed version.

## 8. Integration and Rollout

Suggested service locations below are proposed modules, not existing APIs. Keep pure domain code testable without Solid, IPC or DOM globals; providers compose services and expose reactive snapshots.

| Stage | Work and integration points                                                                                                                                                           | Completion gate                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| S0    | Preserve current fixes; capture shared/adapter behavior and regression fixtures                                                                                                       | This audit and baseline tests; no claim of service migration                                                 |
| S1    | Add contracts and adapter conformance tests; host directory resolver; `app/src/services/runtime` and `workspace-identity` composition                                                 | Both transports enforce the same strict project-open resolution; missing capabilities fail explicitly        |
| S2    | Introduce `project-registry`; route Home, directory dialog, native picker/drop, deep links, recent sessions, project tasks, rail and copy commands through canonical references       | No new raw-path registry writes; scoped aliases deduplicate correctly                                        |
| S3    | Implement the versioned migration and scoped persistence protocol; remap all critical consumers                                                                                       | Crash/retry and conflicting draft tests pass; copied paths and restored tabs are canonical                   |
| S4    | Extend `session-tabs` into the sole navigation/preview coordinator and remove competing effect writers                                                                                | One preview click survives delayed route/model/bootstrap completion; close and Back behaviors remain correct |
| S5    | Make Session Repository, draft submission, file/review caches and model selectors consume the scoped runtime identity and capabilities                                                | Same data lifecycle tests pass for desktop, ordinary Web and remote Web adapters                             |
| S6    | Remove redundant path repair in `remote/bootstrap.ts` and `global-sync.tsx` only after legacy routes and stored records enter through the shared resolver; narrow `Platform` to ports | No bypasses, no duplicate state owners, and no runtime behavior selected by transport identity alone         |

Each stage is a reviewable change, not an application-wide rewrite commit. Do not dual-write independently managed old/new stores during rollout; use one owner behind a compatibility facade. Do not simultaneously change unrelated menus, model snapshots, editor styling or session viewport behavior.

## 9. Verification Gates

Run the same contract suite against native IPC, loopback HTTP and remote HTTP adapters. Use controllable delayed/failing ports for races, not arbitrary sleeps.

| Scenario                                                                                      | Required result                                                                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `~/apps/opencode`, its absolute path and a verified symlink alias                             | One workspace/project record; canonical copied path; display may use `~`                 |
| `/apps` versus `/apps/opencode`; two worktrees of one repository                              | Remain separate workspaces                                                               |
| Same directory and same session ID on two backends                                            | Independent scoped state, subscriptions, tabs and tombstones                             |
| Windows client with POSIX host, POSIX client with Windows host, virtual extra-agent namespace | Host-owned path semantics; no speculative casing/separator changes                       |
| Missing directory, permission denied, unsupported capability, offline retained project        | Distinct typed outcomes; no successful raw-path fallback                                 |
| Page on A, sidebar selects B before A finishes bootstrap or composer autofocus                | B remains selected after one explicit click; displayed rows match B's real session IDs   |
| Rapid A/B switching, reconnect, same-path backend restart, late request completion            | Only the current generation/revision commits                                             |
| SSE update/archive/delete while a list loads                                                  | Event reconciliation preserved; no stale resurrection                                    |
| Alias migration with a live draft, reading mode and editor remount                            | Same draft ID and content survive; newer typing is not reset                             |
| Crash midway through migration, duplicate replay, concurrent window/tab edits                 | Recoverable committed version; no silent overwrites or discarded drafts                  |
| `Request` plus override headers/signal/body and SSE reconnect                                 | Consistent transport semantics; no credential crossing to another origin                 |
| Gateway route/capability mismatch                                                             | Unsupported action is not issued; 401/403 does not create a retry storm                  |
| Real isolated sidecar message and permission workflow                                         | Persisted user/assistant messages verified by the agent; no host user's session modified |

Frontend gates use development Electron CDP 9222 and authenticated remote Web through a temporary loopback gateway. Public verification uses only an already-enabled host and revokes only the QA authorization. Never stop the installed application. Read effective keybind overrides before sending keyboard shortcuts.

Log service, operation, scoped request/intent ID, generation/revision, stage, outcome and counts as strings. Do not log credentials, cookies, CSRF tokens, message bodies or unrestricted user paths through the public gateway. Stale-result drops and migration conflicts must be observable without turning every render into a log event.

## 10. Completion Criteria

The redesign is implemented only when canonical references are used from project admission through persistence, requests, cache selection, copying and navigation; the delayed-bootstrap preview race no longer needs a second click; scoped identities isolate hosts and domains; migration preserves old content; and both adapter suites plus real CDP/sidecar checks pass.

Until then, this document is the migration design. Existing targeted fixes are compatibility measures, not evidence that all client state has been unified.
