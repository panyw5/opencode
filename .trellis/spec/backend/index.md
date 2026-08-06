This is the backend specification index file

## Code Specs

- [Background shell detail snapshots](./background-shell.md)
- [Desktop JSONC agent save reload](./config-file-runtime-reload.md)
- [External advisor contract](./external-advisors.md)


### [CRITICAL] FORBIDDEN BEHAVIOR

#### `createResource` usage

- **DO NOT** use `createResource`, unless you ABSOLUTELY need to suspend the UI while the resource is loading.
- `createResource` reads can trigger Solid `Suspense` fallback and replace the whole route shell while the request is pending.
- For local UI loading state, use `createSignal` for `data/loading/error` and trigger the async work from `createEffect`.
- Keep async state scoped to the smallest UI region that needs it. Do not let a detail-panel fetch suspend the full config page, sidebar, or middle column.
- Never call a resource accessor such as `resource()` in a path that should not suspend. If a resource is unavoidable, prefer non-suspending reads such as `.latest` and guard loading explicitly.
- Use `createEffect` only for side effects. Do not use it to secretly change unrelated navigation state or auto-select defaults that the user did not click.
- Use `createSignal` for explicit UI selection state when a panel must remain stable during async detail loading.


#### Global Session Store Rules

The global session store is an authoritative Session entity cache organized by directory. It is not a general-purpose page state container.

##### Should Write

- Authoritative Session changes produced by server-side events, such as created, updated, archived, or deleted.
- Complete Session entities returned by `session.get` or the main session list.
- Session data that multiple pages or components need to share and that should persist across routes.
- Writes must merge by session ID and preserve directory, parentID, ordering, and existing cache invariants.
- Prefer centralized upsert, reconcile, or event reducer helpers. Do not directly replace the entire session array inside page components.

##### Should Not Write

- Page-specific query results, such as the current subagent sibling list, search results, filtered results, or sorted display lists.
- Derived state, such as the previous/next session, current index, whether navigation is enabled, or menu entries.
- UI state, such as loading, error, selection, hover, expanded state, and request cancellation markers.
- Data used only for a single navigation or a local panel.
- API responses or partial field snapshots that cannot be confirmed as complete Session entities.
- A data source read by the same reactive effect must not be written back inside that effect, to avoid read -> write -> invalidate loops.

##### Page Query Principles

When a page calls queries such as `session.children(parentID)`, keep the result in a local signal by default. Write it to the global store through the unified Session upsert path only when the result is a complete, authoritative Session entity and other pages genuinely need to share it.

Do not write back to the global store just to compute sibling navigation, menus, or temporary lists. Query results may be read-only merged with global entities, but query snapshots must not replace global Session objects or the entire array.

The core decision is: is this authoritative entity state from the server, or query/derived state for the current page? The former may be centralized in the global store; the latter should remain local state.
