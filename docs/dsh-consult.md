# DSH consultation settings

OpenCode invokes an installed `dsh` executable, either from PATH or the configured binary path. It does not require a DeepSeek Harness source checkout or launch DSH through package source files.

In the configuration page, choose **External agents > DeepSeek** and edit **Default DSH invocation**. These defaults are stored in OpenCode rather than a shared DSH profile. The existing model and credential settings are separate.

Profile, timeout, permission preset, and approval policy use dropdowns. Profile choices come from the installed DSH home's `profiles` directory; refresh status after adding a custom profile. Server profiles are omitted. Existing custom values remain selectable even when they are absent from the discovered profiles or common durations and presets. Directory fields use the home launcher's completion menu: type a path, click a directory or use Tab/Enter to complete it, and use the folder button to browse. Extra writable directories are separate removable rows. DSH working-directory and extra-root selections resolve `~` to absolute paths. YAML remains editable text.

External-agent status summaries use the same compact cards as GPT-Pro: an icon, a right-aligned value, and a status indicator. Installation, versions, paths, and connection-test results remain separate; an installed executable does not imply valid authentication or a successful connection test. Path cards retain copy buttons, and the grid adapts to the panel width.

Version cards remain visible while configuration and status load. Each external agent retains its own last-known versions during refresh; saving configuration updates only that agent's local data. Failed status requests report an error in the card area without removing the cards or clearing cached versions.

The equivalent OpenCode configuration is:

```json
{
  "external_agents": {
    "dsh": {
      "enabled": true,
      "defaults": {
        "profile": "headless",
        "timeout_ms": 600000,
        "permission_mode": "read-only",
        "approval_policy": "never",
        "additional_writable_roots": []
      }
    }
  }
}
```

Optional defaults also include `working_directory` (an absolute server-side directory) and `patch` (inline Cordis YAML, or an ordered array of YAML strings). Without defaults, consults use `headless`, the current project directory, a ten-minute timeout, and the profile's permission policy. Timeouts can range from 30 seconds to 30 minutes per turn. Custom profiles must provide a compatible one-shot headless runner, not a Web, SDK, or ACP server.

## Single-call overrides

The `dsh_consult` tool accepts the same fields alongside `prompt`. An explicitly supplied field replaces that field's saved default. Patch and directory arrays are replaced, not appended; `patch: []` or `patch: ""` skips saved patches, and `additional_writable_roots: []` skips saved extra grants. Omitted fields still inherit their defaults. Follow-up interventions retain the resolved profile, patches, timeout and permissions for that consultation.

For example, a call can override the saved read-only mode without changing future calls:

```json
{
  "prompt": "Implement the agreed fix in this workspace.",
  "permission_mode": "workspace-write",
  "approval_policy": "never",
  "additional_writable_roots": []
}
```

## Permissions

`permission_mode` maps to `--permission-mode`; built-in presets include `read-only`, `workspace-write`, and `danger-full-access`. A profile can declare other presets. Select **Inherit DSH policy** in the UI to inherit it. `danger-full-access` removes DSH sandbox restrictions; OpenCode's consultation approval does not sandbox the external process.

`approval_policy` maps to `--approval-policy`. `never` rejects actions requiring approval; it does not grant unrestricted access. `ask` needs an approval handler in the selected DSH profile. OpenCode does not translate internal DSH approval prompts into its own prompts.

`additional_writable_roots` maps to repeatable `--add-dir` arguments under `workspace-write`. Paths must be absolute and are supplied again on every follow-up. External directories pass through OpenCode's existing directory-approval checks. DSH owns platform support and preset validation.

Requested permission flags must appear in the installed CLI/profile help. Unsupported flags or failed capability probes fail the consultation before task submission rather than silently running with different permissions. Updating OpenCode does not update the installed DSH executable.

## Patches

Patches are applied in order after DSH's bundle, profile, and home layers. A Cordis patch replaces a plugin's entire `config`, not just the edited fields. Patches can alter security policy and load executable code; only use trusted contents. Use absolute paths inside inline patches because each patch is materialized in a temporary directory, not beside a project file. The plugin inventory shows the selected profile's persistent tree; temporary call patches and application arguments are not included in that inventory.
