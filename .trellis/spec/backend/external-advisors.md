# External Advisor Contract

## Scenario: Claude CLI advisor

### 1. Scope / Trigger

Use this contract when adding or changing a local CLI exposed as an OpenCode consultation tool and a desktop configuration card. The current implementations are `codex_consult`, `claude_consult`, and `grok_consult`.

### 2. Signatures

OpenCode tool parameters in `packages/opencode/src/tool/claude_consult.ts`:

```ts
type ClaudeConsultParams = {
  prompt: string
  working_directory?: string
  model?: string
  timeout_ms?: number
}
```

Desktop bridge methods are grouped under `cliAgents` in `Platform` and `ElectronAPI`:

```ts
type CliAgentID = "codex" | "claude" | "grok"

cliAgents: {
  list(): Promise<CliAgentDescriptor[]>
  get(id: CliAgentID): Promise<CliAgentConfig>
  set(id: CliAgentID, config: CliAgentConfig): Promise<void> | void
  test(id: CliAgentID, config: CliAgentConfig): Promise<CliAgentTest>
  info(id: CliAgentID, config?: CliAgentConfig): Promise<CliAgentInfo>
}
```

IPC channel names are `cli-agents-list`, `cli-agents-get`, `cli-agents-set`, `cli-agents-test`, and `cli-agents-info`.

### 3. Contracts

- User @-mentions `@codex` / `@claude` / `@grok` in the desktop session composer (when the corresponding CLI is enabled and `installed`) are reserved names.
  - Frontend only lists ready CLIs through `platform.cliAgents`.
  - Backend treats those agent parts as **direct consult tasks** (`MessageV2.latest` → `SessionPrompt.handleConsultMentions`), not as main-agent tool calls.
  - Prompt for the CLI is built by `buildConsultPromptFromParts` from the user turn text + `@file` paths (verbatim), then `codex_consult` / `claude_consult` / `grok_consult` is executed immediately against the local CLI.
  - After consult tools complete, a short synthetic follow-up asks the primary agent only to summarize (do not re-invoke consult).
- `claude_consult` must ask for the `claude_consult` permission before spawning a process.
- `working_directory` defaults to the active instance directory and must pass `assertExternalDirectoryEffect`.
- Runtime resolution uses `which("claude")` in the OpenCode process. Desktop `binaryPath` and `configHome` are persisted probe/card preferences; they are not runtime overrides for the sidecar tool.
- The spawned command must use print mode, stream JSON, `dontAsk`, safe mode, and only `Read,Grep,Glob,LS`.
- Advisor tools register an ephemeral controller keyed by OpenCode `sessionID` and tool `callID`. When the user starts intervention before an advisor turn ends, the tool withholds its final result, accepts follow-up messages, and releases the result only after the user ends intervention.
- Codex follow-ups use `codex exec resume <threadID>`; Claude follow-ups use `claude -p --resume <sessionID>`; Grok follow-ups use `grok --single <prompt> --resume <sessionID>`. Grok uses `--output-format streaming-json`, whose `end.sessionId` is the persisted resume identifier, and runs with its full tool set under `--permission-mode bypassPermissions` so it can edit, execute shell commands, and access the network.
- Each desktop card persists its `CliAgentConfig` under a stable agent-specific storage key and probes its configured binary and config file. Grok reads `[ui].fork_secondary_model` (or root `model`) and falls back to `<configHome>/bin/grok` when `PATH` does not contain the CLI.
- Desktop config/status calls flow through the `cliAgents` registry in preload and renderer. Cards are rendered from descriptors returned by `platform.cliAgents.list()`.
- Entering the external-agent section preloads the config and status for every registered CLI agent so list metadata does not change as a side effect of selecting a card.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Empty `prompt` | Reject before spawning Claude |
| Directory outside allowed workspace | Reject through external-directory validation |
| Claude missing from runtime `PATH` | Return an install/PATH error |
| Timeout below 30 seconds | Clamp to 30 seconds |
| Timeout above 30 minutes | Clamp to 30 minutes |
| Abort or timeout | Kill the child process and return a specific error |
| Intervention starts after a completed or unknown tool call | Reject the request; never create a detached advisor session |
| Intervention message while advisor is producing output | Queue one message and resume it after the current advisor turn completes |
| Intervention ends during advisor output | Let that output complete, then return the final tool result to OpenCode |
| Non-zero exit without a response | Include bounded stderr/stdout detail in the error |
| Invalid desktop `settings.json` | Keep install probe usable and omit invalid settings fields |
| Missing desktop binary | Return `installed: false`; do not throw across IPC |

### 5. Good/Base/Bad Cases

- Good: authenticated Claude reads workspace files through the allowlisted tools and returns a streamed advisory response with usage metadata.
- Base: Claude is installed with no `settings.json`; the card reports the version and unknown model while consultation still works.
- Bad: the request points outside the workspace or attempts to rely on write-capable tools; validation or the fixed tool allowlist prevents it.

### 6. Tests Required

- `bun test test/tool/consult-mention.test.ts` from `packages/opencode`: assert reserved id mapping and synthetic text requirements.
- `bun test src/components/prompt-input/consult-mentions.test.ts` from `packages/app`: assert ready-CLI filtering for the @ menu.
- `bun test test/tool/codex_consult.test.ts test/tool/claude_consult.test.ts test/tool/grok_consult.test.ts test/tool/advisor-intervention.test.ts` from `packages/opencode`: assert argv restrictions, resume arguments, JSONL parsing, timeout clamping, parameter schema, and intervention state transitions.
- `bun test src/main/claude-status.test.ts` from `packages/desktop`: assert valid and invalid settings parsing.
- `bunx tsgo --noEmit -p packages/app/tsconfig.json`: assert renderer/platform type agreement.
- `bunx tsgo --noEmit -p packages/desktop/tsconfig.json`: assert IPC/preload/native type agreement.
- Parameter snapshots must include `claude_consult` whenever its public schema changes.

### 7. Wrong vs Correct

#### Wrong

```ts
ChildProcess.make("claude", ["-p", prompt], { cwd })
```

This allows local customizations and the default tool set to change advisory behavior.

#### Correct

```ts
buildClaudeExecArgs({ prompt, workingDirectory: cwd, model })
// Includes safe mode, dontAsk, no persistence, and Read/Grep/Glob/LS only.
```
