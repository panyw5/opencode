## Scenario: JSONC Agent Runtime Config Refresh

### 1. Scope / Trigger

- Trigger: `packages/app/src/pages/config.tsx` saves an `agent.<name>` entry directly to the global `opencode.jsonc` through `Platform.writeConfigFile`.
- A successful file write alone leaves the running sidecar with a stale agent model, so the save flow must invalidate its config cache before reporting success. Do not restart the sidecar for a normal agent save.

### 2. Signatures

```ts
type ConfigRefreshInput = {
  refreshConfig: () => Promise<unknown>
  refresh?: () => void
  source: string
}

refreshAfterConfigWrite(input: ConfigRefreshInput): Promise<void>

// Renderer -> current server process
POST /global/config/refresh
```

### 3. Contracts

- `saveJsoncAgent()` writes the JSONC file before calling `refreshAfterConfigWrite()`.
- The required order is: `globalSync.refreshConfig(mainDomain)`, then local agent resource revision refresh.
- `refreshConfig()` calls `POST /global/config/refresh`, which runs `Config.refreshGlobal()`: it invalidates the global config cache and all instance config states without restarting the server process. It then fetches `config.get` for current frontend state.
- If the refresh rejects, propagate the error to `JsoncAgentEditor`; do not show the success toast and do not refresh the local agent list as though the new model were active.
- The server `config.agent` response is merged with Markdown agent definitions. The editable `opencode.jsonc` agent group must use only `configuredAgentsFromJsonc(readConfigFile(opencode.jsonc))`; never use `cfg().agent` to classify JSONC entries.
- Log every save, file write, runtime refresh request/completion, and local resource refresh with source/agent context.

### 4. Validation & Error Matrix

| Case | Expected |
| --- | --- |
| Desktop file write and successful runtime refresh | Save resolves, global config cache and agent resource refresh run, future calls use the new model |
| JSONC validation error before write | No file write or runtime refresh occurs; editor shows the validation error |
| File write failure | No runtime refresh occurs; editor shows the write error |
| Runtime refresh request fails | Save rejects after the file remains written; editor shows refresh error and does not refresh the local agent list |
| Sidecar stays healthy | No process restart, no connection interruption, and no session loss |
| Provider refresh with Markdown agent metadata | File-defined agents remain only in the global/file group; no duplicate JSONC cards |

### 5. Good/Base/Bad Cases

- Good: Editing `agent.research.model`, saving, waiting for the config refresh response, then creating a session that invokes `research` with the new model.
- Base: Provider refresh uses `globalSync.refreshConfig(mainDomain)` for the same server-side config cache invalidation.
- Bad: Updating only `setConfigFileAgents()` after a direct file write. That changes the settings display but leaves `Config.Service` and `Agent` in the sidecar unchanged.

### 6. Tests Required

- `cd packages/app && bun test --preload ./happydom.ts ./src/utils/config-reload.test.ts`: assert runtime refresh -> local refresh ordering and a failed refresh does not run local refresh.
- `cd packages/app && bun test --preload ./happydom.ts ./src/pages/config-agent-display.test.ts`: assert merged Markdown agent names without JSONC entries do not render as JSONC configuration cards.
- `cd packages/app && bun run typecheck`: verify renderer platform types.
- Manual desktop check: change a JSONC agent model, save, confirm no sidecar restart occurs, and invoke the agent to confirm the new model.

### 7. Wrong vs Correct

#### Wrong

```ts
await platform.writeConfigFile(file.path, text)
await platform.reloadBackend()
showToast({ variant: "success", title: t("common.save") })
```

#### Correct

```ts
await platform.writeConfigFile(file.path, text)
await refreshAfterConfigWrite({
  source: `jsonc-agent:${name}`,
  refreshConfig: () => globalSync.refreshConfig(mainDomain),
  refresh: () => bump("workspaceRev", "agentRev"),
})
showToast({ variant: "success", title: t("common.save") })
```
