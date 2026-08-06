## Scenario: Background Shell Detail Snapshots

### 1. Scope / Trigger

- Trigger: UI needs to show the current output for a single PTY-backed background shell after a user selects it from the background shell menu.
- This is a cross-layer contract: frontend menu/dialog code calls the existing session-scoped list HTTP API, which calls `BackgroundShell.Service.list()`, which refreshes running PTY snapshots before returning.

### 2. Signatures

```typescript
// Backend HTTP API
GET /background-shell?directory=<workspace>&sessionID=<session>

// Frontend helper
listBackgroundShells(input: {
  sdk: ReturnType<typeof useSDK>
  platform: ReturnType<typeof usePlatform>
  auth?: { username?: string; password?: string }
  sessionID?: string
}): Promise<BackgroundShellInfo[]>
```

### 3. Contracts

- Response body is `BackgroundShell.Info[]`.
- `outputTail` is the latest retained PTY output tail, limited by the backend `OUTPUT_LIMIT`.
- Running shells returned by the list must be refreshed via `pty.snapshot()` before returning.
- Detail UI must find the selected `id` in the returned array; if missing, show a local "not found" error.
- Remote/basic-auth instances must include the same authorization header used by list/create/background helpers.
- Do not add a separate detail route unless the currently running desktop/web server path is guaranteed to route it; otherwise a stale server can return the app HTML fallback and break `response.json()`.

### 4. Validation & Error Matrix

| Case | Expected |
| --- | --- |
| Existing running shell in session list | `200`, array item has refreshed `status: "running"` and refreshed `outputTail` when PTY snapshot exists |
| Existing completed/error/stopped shell in session list | `200`, array item has stored terminal status and final `outputTail` |
| Unknown shell ID in detail UI | `200` list response, then local "Background shell not found" error |
| Missing/invalid workspace routing | Workspace routing middleware rejects before handler |
| Remote auth required | Authorization middleware rejects when header is missing or invalid |
| Stale app/server without detail route | UI still works because it only calls the existing list route |

### 5. Good/Base/Bad Cases

- Good: The UI opens a detail dialog with the selected list snapshot, then calls `listBackgroundShells()` for the current session and selects the matching id.
- Base: The background shell menu uses `listBackgroundShells()` for session-scoped discovery and counts.
- Bad: Do not call a newly added detail endpoint from the dialog if the app may be running against a stale server that does not know the route.

### 6. Tests Required

- API exercise should cover `background-shell.list`, `background-shell.create`, `background-shell.background`, and `background-shell.stop`.
- UI test should assert selecting a background shell item opens the output dialog and invokes the session list loader.
- Remote/server test should cover auth header propagation for the detail helper when credentials are configured.

### 7. Wrong vs Correct

#### Wrong

```typescript
const openBackgroundShell = (entry: BackgroundShellInfo) => {
  dialog.show(() => <ShellOutput entry={entry} load={(id) => getBackgroundShell({ sdk, platform, auth, id })} />)
}
```

#### Correct

```typescript
const openBackgroundShell = (entry: BackgroundShellInfo) => {
  dialog.show(() => (
    <ShellOutput
      entry={entry}
      load={async (id) => {
        const items = await listBackgroundShells({ sdk, platform, auth, sessionID })
        const next = items.find((item) => item.id === id)
        if (!next) throw new Error("Background shell not found")
        return next
      }}
    />
  ))
}
```
