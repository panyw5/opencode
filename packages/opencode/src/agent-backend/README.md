# External Agent Backends

The external advisor tools (`codex_consult`, `claude_consult`, `grok_consult`,
`dsh_consult`, `pi_consult`) share one boundary:

```text
Session / UI
  -> external session projection and intervention
  -> AgentBackend (validated input, normalized events and metadata)
  -> ACP | native RPC | CLI JSON
```

OpenCode's built-in agents still use its own model/tool loop. Browser-based
GPT Pro and the standalone Hermes/GenericAgent servers are separate integrations.

## Configuration

Add `agent_backends` to your project's `opencode.json` or global configuration.
Omitting an advisor keeps its existing implementation: Pi uses native RPC;
Codex, Claude, Grok and DSH use their existing CLI JSON runners. Existing
`external_agents` and `pi` enable switches still apply.

```json
{
  "external_agents": { "claude": { "enabled": true } },
  "agent_backends": {
    "claude": {
      "type": "acp",
      "command": ["/absolute/path/to/your-acp-adapter"],
      "permission": "deny"
    },
    "codex": { "type": "cli-json" },
    "pi": { "type": "native-rpc" }
  }
}
```

`command` is a nonempty argv array, never shell text. Install your chosen adapter
through the configuration panel or supply an existing executable's arguments.
Opening settings or loading project configuration never installs packages.
Optional ACP fields are `env` (environment overrides), `model`, `mode`, and
`permission` (`deny`, the default, or `ask`). Commands and environment values are
explicit trusted configuration. Desktop CLI binary/config-home settings do not
rewrite the ACP command; supply adapter-specific environment/configuration there.

The `model` tool parameter overrides the configured ACP model. Model and mode
selection use advertised session config options, with legacy ACP model/mode
methods as a fallback. Unsupported selections fail rather than being ignored.
DSH's CLI-specific tool parameters cannot be used with ACP; configure your
adapter through `command`/`env` instead. DSH CLI defaults apply only to CLI JSON.

## Managed Installation

Config > External Agents exposes transport selection, reviewed adapter releases,
installation confirmation, version selection, connection tests and authentication
guidance. Claude, Codex and Pi have pinned npm recipes in `catalog.ts`; DSH and
Grok currently use existing/custom ACP commands. The catalog is reviewed and
append-only: an online registry or project cannot supply executable install steps.

Installations live under the connected backend's data directory in
`agent-backends/versions/<advisor>/<version>`. npm is invoked without a shell,
with lifecycle scripts disabled and the root package's integrity checked against
the reviewed SHA-512 value. Transitive resolutions are recorded in each version's
package-lock. Node.js >=22 and npm are prerequisites; Pi also needs its CLI.

Install/remove operations require a short-lived, one-use confirmation token
bound to an exact action, adapter and release. Installation never enables ACP.
The exact draft must pass an ACP/session connection test before the UI enables
it. A separate explicit consent is required to send a model test prompt.

Older reviewed releases remain available for side-by-side installation and
rollback by selecting and testing that version before enabling it. Uninstallation
never removes global CLIs or account credentials. Filesystem locks coordinate
multiple sidecars; runtime leases prevent deletion while a managed version is in
use. The `managed` configuration reference resolves on the target backend rather
than trusting a saved absolute path from another machine.

Browser-based ACP authentication can be initiated explicitly on a local backend.
Environment/terminal methods and remote login display guidance and must be
completed on the target machine. A successful handshake does not prove that an
account has credits; only the optional message test exercises a model request.
Adapter management endpoints require server authorization and are disabled in
pure mode.

## Lifecycle and Safety

- One ACP process/session per consultation, reused for intervention follow-ups.
- Streaming messages, reasoning, tool updates and plans feed the existing child
  session UI. Preview limits do not truncate the persisted event stream.
- The process is closed when the consultation finishes. Startup is limited to
  30 seconds; the existing per-turn timeout parameter applies to prompts.
- Cancellation sends `session/cancel`, then terminates the owned process group
  on POSIX (the direct child on Windows), escalating after a grace period.
- No automatic retry or cross-backend fallback: a failed request may already
  have performed operations. Change configuration explicitly before retrying.
- `permission: deny` refuses ACP permission requests. `ask` routes each request
  through OpenCode's `external_agent_tool` permission rules and only grants
  `allow_once`. Configure that permission as `ask` for interactive approval.
- The client advertises no host filesystem or terminal callbacks. This does
  **not** sandbox the adapter's own tools. Use a trusted adapter and its native
  read-only/sandbox controls; a read-only prompt is not a security boundary.
- Sessions are not automatically resumed after a process crash or app restart.
  Existing transcripts remain readable through OpenCode's session storage.

The `src/acp` module serves the opposite direction: OpenCode as an ACP agent for
external editors. It is not the client backend implemented here.

## Verification

From `packages/opencode`:

```sh
bun test test/agent-backend test/pi test/tool/*consult*.test.ts test/session/external*.test.ts
bun run typecheck
```

`packages/desktop/scripts/agent-backend-e2e.ts` exercises all three backends
through an isolated bundled Electron sidecar and verifies persisted child
messages and backend logs without using paid models.

Run it with `--desktop --install-ui` to also verify real managed installation,
confirmation cancellation, authentication status, removal and the configuration
page's explicit message test. `script/test-agent-adapter-install.ts` downloads
the reviewed releases into a temporary store, checks their real ACP handshake
without model prompts, and removes them again.
