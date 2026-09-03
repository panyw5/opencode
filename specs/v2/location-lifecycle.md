# Location Lifecycle

Status: proposal

## Summary

OpenCode already has durable Project identity, Project Location identity, and
per-domain frontend state ownership. It does not yet have one owner for the
runtime lifecycle of a Location.

Today a renderer child-store eviction can dispose a backend instance even when
backend work still uses it, while the backend cannot reclaim an instance on its
own when the renderer disappears. Project rail state, route restoration,
per-workspace stores, Project Location availability, and `InstanceStore` can
therefore disagree.

This proposal adds a backend `LocationLifecycle` module. It is the shared gate
for full instance admission, idle disposal, reload, and Location deletion. It
uses the existing `ProjectLocation` identity, scoped operation leases, a
per-Location generation, and a durable deletion fence.

The MVP does not delete Session history or introduce broad cache garbage
collection. It first establishes runtime safety and a single source of truth.

## Context

Several earlier changes established the identity model this proposal builds on:

- `26eec45514` unified frontend Project ownership resolution. Exact worktree
  ownership wins over stale sandbox ownership.
- `71902f7d32` introduced durable Project Locations, aliases, canonical
  directories, `location_id`, VCS state, and last-seen timestamps.
- `845c9a6189` repaired duplicate legacy Project ownership and transactionally
  moved Sessions, Scheduled Tasks, and Workspaces to a trusted Project Location.
- `13f92245ce` isolated frontend synchronization and child stores by domain.
- `cf361ff14a` and `ae9e5a2eb1` repaired several project rail open, close, and
  route resurrection problems.

Those changes answer three questions:

1. Which logical Project owns a resource?
2. Which physical Location belongs to that Project?
3. Which backend domain owns the state?

They do not answer the runtime question:

> May a new operation enter this Location, and when is it safe to stop or
> delete the Location runtime?

The historical Workspace design in `56405af7d6` explicitly deferred lifecycle
to a separately reviewed plan and required one shared gate for Session
creation, Location admission, deactivate, reactivate, and delete. It also noted
that cache invalidation is not a lifecycle fence.

## Current Problems

### Frontend cache eviction controls backend lifetime

`packages/app/src/context/global-sync/child-store.ts` evicts renderer stores by
frontend pins, bootstrap activity, session loading, a 30-store cap, and a
20-minute idle period. Its callback in
`packages/app/src/context/global-sync.tsx` calls `client.instance.dispose()`.

Frontend pins do not include backend Scheduled Tasks, Session runs, PTYs,
background jobs, another renderer, or another client. Dropping a renderer cache
is therefore incorrectly treated as proof that the backend runtime is unused.

### Backend instances cannot reclaim themselves

`packages/opencode/src/project/instance-store.ts` keeps instances in an
unbounded `Map`. `packages/opencode/src/effect/instance-state.ts` uses
per-directory scoped caches with infinite capacity. Instances are released only
by explicit disposal, failed load, runtime shutdown, or `disposeAll`.

There is no operation lease, active reference count, idle timer, admission
fence, or per-Location closing state.

### Worktree deletion is not fenced

`packages/opencode/src/worktree/index.ts` can remove a worktree directory while
an instance for that directory still owns watchers, LSP clients, MCP clients,
PTYs, or background work. The worktree HTTP handler removes Project sandbox
metadata after filesystem deletion but does not first close the target
Location runtime.

### Routes and background tasks can restart stale Locations

The frontend route registration tombstone only guards project rail
registration. `SyncProvider` independently warms its route directory. A stale
but existing route can therefore restart an instance after the user closes the
Project.

HTTP instance middleware rejects missing directories before full bootstrap,
but internal callers such as Scheduled Tasks call `InstanceStore.load()`
directly and do not cross that check.

### Availability has multiple writers

The backend has `ProjectLocation.vcsState`, including `unavailable`. The
frontend separately keeps an in-memory `unavailableDirectories` set. Project
and sandbox list readers also perform their own filesystem filtering without
always updating the durable Location record.

There is no authoritative transition observed by every projection.

## Goals

1. Put every full runtime admission behind one backend module.
2. Prevent new admissions once close, reload, or delete establishes a fence.
3. Keep an instance alive while any real operation uses it.
4. Reclaim an instance after its final lease becomes idle.
5. Dispose a target runtime before deleting its worktree.
6. Make deletion retryable and safe across process failure.
7. Prevent stale asynchronous work from publishing into a new lifecycle
   generation.
8. Keep Project and Session history after a Location becomes unavailable or is
   deleted.
9. Treat renderer state and workspace stores as projections or caches, never as
   runtime authority.
10. Preserve domain authority for local, WSL, SSH, HTTP, extra-agent, and hosted
    execution.

## Non-Goals

The MVP does not:

- migrate all routes, tabs, and workspace stores from paths to `LocationID`;
- delete historical Sessions when a directory disappears;
- add a workspace store index or retention GC;
- add forced cancellation of active Scheduled Tasks, PTYs, or background jobs;
- infer permanent deletion from a single `ENOENT`;
- implement hosted Workspace stop and destroy policy;
- make notification or error-sound history part of lifecycle state;
- expose a new public lifecycle API before the internal gate is proven.

## Ownership

Each fact has one writer:

| Fact | Owner |
| --- | --- |
| Logical repository identity | `Project` |
| Checkout or directory identity | `ProjectLocation` |
| Location availability and deletion transition | `LocationLifecycle` |
| Runtime state and operation leases | `LocationLifecycle` |
| Instance construction and resource finalization | `InstanceStore` adapter |
| A client's open project rail | That client's UI registry |
| Renderer workspace state | Cache adapter |
| Historical Session data | SQLite Session storage |

`LocationLifecycle` is the only module allowed to combine availability,
admission, runtime startup, runtime disposal, and deletion ordering.

The UI may detach a Project from its rail. It may not conclude that a backend
runtime is globally unused. `InstanceStore` may construct and finalize runtime
resources. It may not independently admit an operation or decide business
availability.

## Identity

The durable identity is an existing `ProjectLocation`:

```ts
type LocationIdentity = {
  domain: DomainID
  projectID: ProjectID
  locationID: LocationID
  canonicalDirectory: string
}
```

The domain is required. The same path string may refer to unrelated resources
on a local sidecar, WSL distribution, SSH server, or hosted provider.

The first implementation may accept a directory from legacy callers, but it
must canonicalize and resolve that directory to a `LocationID` inside the gate.
No new persistent relationship should be keyed only by directory.

## Durable State

`vcs_state` remains VCS discovery state. It must not be overloaded with runtime
or deletion semantics.

Add lifecycle fields to `project_location`:

```text
lifecycle_state       available | unavailable | deleting | deleted
lifecycle_generation  integer not null default 0
delete_operation_id   nullable text
time_unavailable      nullable integer
time_deleted          nullable integer
```

Meanings:

- `available`: admission may proceed.
- `unavailable`: admission is rejected, but the Location may recover.
- `deleting`: a durable deletion fence exists and startup recovery is required.
- `deleted`: a durable tombstone prevents stale routes or tasks from reviving
  the Location.

Migration must not mark an existing row deleted merely because its local path
is currently missing. Network mounts, remote paths, and temporarily detached
storage make that unsafe. Such rows remain available until observed through
the correct domain, or become unavailable through an authoritative
observation.

Runtime state remains in memory because a process restart invalidates all
claims that a runtime is running:

```ts
type RuntimeState =
  | { tag: "stopped"; generation: number }
  | { tag: "starting"; generation: number; leases: number }
  | { tag: "running"; generation: number; leases: number }
  | { tag: "draining"; generation: number; leases: number }
  | { tag: "stopping"; generation: number }
```

## Interface

The module should expose a small Effect service interface:

```ts
interface LocationLifecycle {
  readonly provide: <A, E, R>(
    input: {
      directory: string
      purpose: AdmissionPurpose
    },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AdmissionError, R>

  readonly exclusive: <A, E, R>(
    input: {
      directory: string
      operation: "delete" | "reset" | "reload"
      mode: "fail-if-busy"
    },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AdmissionError | LocationBusy, R>

  readonly delete: (
    input: DeleteLocationInput,
  ) => Effect.Effect<DeleteLocationResult, DeleteLocationError>

  readonly observe: (
    input: LocationObservation,
  ) => Effect.Effect<LocationSnapshot>

  readonly snapshot: (
    locationID: LocationID,
  ) => Effect.Effect<LocationSnapshot, LocationNotFound>
}
```

Callers do not receive separate public `acquire()` and `release()` methods.
`provide()` owns release in a Scope finalizer, so success, failure,
interruption, and client disconnect follow the same path.

`InstanceStore.load()` becomes an implementation detail of
`LocationLifecycle`. Direct production callers are removed as the migration
progresses.

## Admission Purposes

Initial purposes:

```ts
type AdmissionPurpose =
  | "http-request"
  | "session-run"
  | "scheduled-task"
  | "pty"
  | "background-job"
```

An open rail item, notification, historical Session, title lookup, or renderer
child store is not a runtime lease.

Lightweight database-backed Session reads should continue to avoid full
instance admission where possible.

## Lease Rules

1. Admission resolves and canonicalizes a Location before changing runtime
   state.
2. `deleting` and `deleted` reject all new leases.
3. `unavailable` returns a typed error and does not call Project discovery or
   instance bootstrap.
4. The first lease starts the runtime. Concurrent leases share the same start.
5. Every admitted operation owns exactly one scoped lease.
6. The final lease release schedules idle disposal.
7. PTYs and background jobs hold leases until terminal settlement or finalizer
   completion.
8. A Scheduled Task holds a lease for the complete prompt execution, not only
   initialization.
9. A renderer disconnect releases request or connection leases; it does not
   release an independently running backend task lease.
10. UI child-store eviction never releases leases it does not own.

## Concurrency

Each Location uses an independent serialized state, following the repository's
existing `SynchronizedRef` patterns. A global lock would couple unrelated
Projects and is not acceptable.

State transitions occur atomically. Slow work such as Git, filesystem calls,
driver calls, bootstrap, and disposal runs outside the state lock. Completion
re-enters the lock and checks the captured generation before publishing.

The generation increments when:

- deletion starts;
- reload starts;
- a deleting transition is cancelled;
- forced disposal starts;
- a hosted placement is replaced.

An asynchronous result from an older generation must not update state, publish
ready, restore a route, or populate a cache. It must finalize any resources it
created.

## Idle Disposal

The backend, not the renderer, owns idle disposal.

Initial policy:

```text
last lease released -> 2 minute idle period -> dispose runtime
```

The timer captures the Location generation. At expiry it disposes only when:

- the generation is unchanged;
- lifecycle state is available;
- runtime state is running;
- lease count remains zero.

A new lease makes an old timer a no-op. Server shutdown cancels timers and
disposes all runtimes.

The initial two-minute value is conservative and may be tuned after observing
runtime startup cost and real lease distributions.

## Delete Fence

Deleting a Location is a durable transaction, not a cache invalidation.

The MVP uses `fail-if-busy` semantics:

```text
1. Resolve Location and validate delete authority.
2. Persist lifecycle_state=deleting and increment generation.
3. Reject new admissions.
4. Publish a Location-deleting event.
5. Verify that active lease count is zero.
6. Dispose the runtime and wait for finalizers.
7. Remove the Git worktree and filesystem directory.
8. Remove the sandbox from Project metadata.
9. Persist lifecycle_state=deleted and time_deleted.
10. Publish a Location-deleted event.
11. Let clients remove rail, route, tab, and cache projections.
```

If active leases exist, the delete request returns `LocationBusy` before
filesystem mutation. Forced cancellation is deferred until product semantics
for Sessions, PTYs, Scheduled Tasks, and background jobs are explicit.

If filesystem deletion fails, the Location remains `deleting`. The operation
ID makes retry idempotent. Admission stays closed until retry or an explicit
cancellation transition increments the generation and re-observes the
Location.

At startup, `deleting` rows are recovered conservatively:

- if the directory is absent, finish metadata cleanup and mark deleted;
- if the directory remains, keep the fence and require retry or cancellation;
- never resume a route or Scheduled Task against a deleting row;
- never recursively delete a still-present directory without an explicit
  delete operation.

## Unavailable Is Not Deleted

A single missing-path observation is insufficient proof of permanent deletion.

`unavailable` covers:

- disconnected network or cloud mounts;
- an unavailable SSH or WSL backend;
- permission failures;
- transient Git worktree mutation windows;
- externally removed local paths that have not been confirmed as deleted.

Unavailable Locations reject full runtime admission but retain Project,
Session, and workspace cache data. They may transition back to available after
an authoritative observation in their own domain.

`deleted` is reserved for:

- a completed OpenCode delete transaction;
- explicit user confirmation for an externally deleted local Location;
- a provider driver confirming permanent hosted resource deletion;
- an administrative delete operation.

## Adapter Changes

### HTTP instance context

Replace:

```text
existsSafe -> InstanceStore.load -> handler
```

with:

```text
resolve Location -> LocationLifecycle.provide(http-request) -> handler
```

The existing missing-directory response may remain as a compatibility mapping,
but the internal error originates from the lifecycle module.

### Scheduled Tasks and Session runs

Wrap complete execution in `LocationLifecycle.provide`. An unavailable Location
produces a skipped or unavailable run outcome. A deleting or deleted Location
must never invoke Project discovery or instance bootstrap.

### PTYs and background jobs

Acquire a long-running lease only after successful creation. Release it on
terminal settlement, kill confirmation, creation failure, or Scope
finalization. Release must be idempotent.

### Worktree deletion

The worktree handler delegates the whole operation to
`LocationLifecycle.delete`. `Worktree.remove` becomes a filesystem adapter
inside the fenced operation rather than a top-level lifecycle decision.

### Frontend child stores

Child-store eviction releases renderer memory, aborts renderer requests, and
drops renderer SDK caches. It no longer calls `client.instance.dispose()`.

### Frontend project close

Closing a rail Project is a client detach operation. It removes the rail entry,
tabs, and route intent, and closes streams owned by that client. It does not
force global backend teardown.

The existing `lastProject` resurrection path and route-based implicit project
registration must be removed or changed to require an explicit open intent.

## Errors

The domain error set begins with:

```ts
LocationNotFound
LocationUnavailable
LocationDeleting
LocationDeleted
LocationBusy
LocationGenerationMismatch
LocationDeleteFailed
```

Use typed Effect errors inside the module. HTTP handlers map them to explicit
protocol errors. Filesystem and driver details must not leak directly through
the public error shape.

## Observability

Lifecycle logs are strings with stable operation fields:

```text
[location-lifecycle] admission-request location=... generation=... purpose=...
[location-lifecycle] lease-acquired location=... generation=... purpose=... leases=...
[location-lifecycle] lease-released location=... generation=... purpose=... leases=...
[location-lifecycle] idle-scheduled location=... generation=... delayMs=...
[location-lifecycle] idle-cancelled location=... generation=... reason=...
[location-lifecycle] runtime-started location=... generation=...
[location-lifecycle] runtime-disposed location=... generation=... reason=...
[location-lifecycle] delete-fenced location=... generation=... operation=...
[location-lifecycle] delete-blocked location=... leases=...
[location-lifecycle] delete-completed location=... generation=... operation=...
```

Metrics or debug snapshots should expose runtime count, active lease count,
idle runtime count, deleting Location count, disposal duration, and rejected
admission count. They must not make frontend cache state authoritative.

## MVP Implementation Plan

### PR 1: Characterization and shadow admission

1. Add characterization tests for missing directory admission, child-store
   disposal, Project close resurrection, and worktree deletion ordering.
2. Add `LocationLifecycle` with per-directory serialized state and scoped
   leases in shadow mode.
3. Route full HTTP instance requests through `LocationLifecycle.provide`.
4. Keep current disposal behavior and disable idle disposal.

Suggested commits:

```text
test(instance): cover directory lifecycle gaps
feat(instance): add location lifecycle admission gate
refactor(server): admit instance routes through lifecycle
```

PR 1 may ship independently because it does not change resource retention.

### PR 2: Backend work leases

1. Route Scheduled Task and Session execution through scoped leases.
2. Route PTY and background job lifetime through long-running leases.
3. Verify that success, failure, interruption, and finalization release exactly
   one lease.

Suggested commits:

```text
refactor(session): lease location runtime during execution
refactor(runtime): lease locations for persistent jobs
```

Idle disposal remains disabled until PR 2 covers every long-running operation.

### PR 3: Durable deletion fence

1. Add lifecycle state, generation, delete operation, and timestamps to
   `project_location`.
2. Add migration and persistence tests.
3. Move worktree deletion behind `LocationLifecycle.delete`.
4. Add startup recovery for `deleting` rows.

Suggested commits:

```text
feat(project): persist location deletion lifecycle
fix(worktree): fence instance admission before removal
```

### PR 4: Ownership cutover

1. Enable backend idle disposal.
2. Remove backend disposal from frontend child-store eviction.
3. Make Project detach durable and remove `lastProject`, sandbox folding, and
   route warm resurrection paths.
4. Add end-to-end resource and concurrency tests.

Suggested commits:

```text
feat(instance): dispose idle location runtimes
fix(app): decouple child cache eviction from backend disposal
fix(app): make project detach durable
```

The idle disposal and frontend ownership removal changes must release together.
Shipping only one side would either leak instances or preserve unsafe frontend
teardown authority.

## Test Invariants

The interface is the test surface. Tests must prove:

1. `deleting` and `deleted` never admit a new lease.
2. An active lease prevents idle disposal and deletion.
3. The directory is not removed before the final runtime disposer completes.
4. A stale generation cannot publish a started runtime or cache result.
5. Concurrent admissions boot one runtime and hold independent leases.
6. Success, typed failure, defect, interruption, and disconnect release leases.
7. Child-store eviction does not affect a Scheduled Task lease.
8. A renderer detach does not affect another client or backend task.
9. Scheduled Tasks do not call Project discovery for unavailable, deleting, or
   deleted Locations.
10. Delete retries are idempotent across each failure point.
11. Startup recovery cannot revive a deleting Location.
12. Unavailable Locations can recover; deleted Locations cannot implicitly
    recover.
13. Session history remains readable without activating its historical
    Location.
14. Workspace cache content cannot register or admit a Location.
15. Server shutdown disposes all remaining runtimes after explicitly handling
    active operations.

Use `TestClock` for idle policy tests and existing scoped test fixtures for
filesystem, Git, HTTP, and runtime resources.

## Release Validation

Before enabling ownership cutover:

1. Run shadow admission in development and verify that every full instance
   load has an admission purpose.
2. Add a temporary assertion or diagnostic for direct production calls to
   `InstanceStore.load()`.
3. Verify watcher, LSP, MCP, PTY, and background job counts fall after idle
   disposal.
4. Open and leave 100 directories; runtime count must return to a small
   baseline after the idle period.
5. Run a Scheduled Task while evicting its renderer child store; execution must
   complete normally.
6. Attempt worktree deletion during HTTP, Session, Scheduled Task, PTY, and
   background job leases; all must return busy without filesystem mutation.
7. Crash between worktree removal and the final database transition; restart
   must finish the tombstone without reviving the Location.
8. Verify that old desktop state containing a removed directory cannot trigger
   full bootstrap.

## Follow-Up Work

After the MVP is stable:

- persist frontend rail entries as `serverKey + LocationID`;
- add a LocationID-based workspace cache index and retention GC;
- add explicit Deactivate and force-delete product semantics;
- add multi-window client intent synchronization;
- integrate hosted Workspace driver stop and destroy operations;
- add UI states for unavailable, deleting, deleted, and historical Locations;
- add retention policy for error-sound diagnostics;
- remove legacy path-only lifecycle interfaces.

## Decision

Do not fix directory lifecycle by adding independent cleanup timers to every
state layer. Build one backend Location admission and deletion gate on top of
the existing Project Location identity. Runtime resources follow scoped leases;
UI state and workspace stores remain projections and caches.
