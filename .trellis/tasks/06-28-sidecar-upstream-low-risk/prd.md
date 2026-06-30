# merge low-risk upstream sidecar and provider updates

## Goal

Bring in low-risk upstream updates that improve the Electron desktop sidecar experience, provider configuration compatibility, and LLM protocol behavior without changing session database structure.

## Scope

- Low-risk desktop UI/sidecar-adjacent fixes.
- Low-risk provider and LLM protocol fixes needed for new OpenAI/Codex style channels.
- No session database schema migrations in this phase.
- Medium-risk SDK/API/event-stream changes are deferred until after manual testing.

## Low-Risk Candidates

- `bdfea046db` desktop connect-provider dialog auth metadata prompt recognition.
- `9903abc704` allow empty provider config default.
- `5f61d21487` pass strict through tool definitions for Codex parity.
- `f254476043` omit stateless OpenAI response item IDs.
- `11d2f3e5f8` end reasoning before responses.

## Medium-Risk Candidates

- MCP/OAuth fixes: refresh token scope, OAuth completion errors, reauthentication credential refresh, auth status scoping, timeout split.
- SDK live event stream and finite session history APIs.
- Desktop moved/deleted project path handling from `desktop-relocated`.

## Explicitly Out of Scope

- Moving database schema ownership to `packages/core`.
- Removing JSON storage migration.
- Altering `session_message`, `permission`, or session table structure.
- Snapshot/revert/session metadata database migrations unless handled as a separate task.

## Acceptance Criteria

- Low-risk changes are merged in a new worktree branch.
- No files under storage DB schema or migration directories are changed.
- Typecheck or focused tests are run where practical.
- Medium-risk updates are left for a second pass after manual testing.
