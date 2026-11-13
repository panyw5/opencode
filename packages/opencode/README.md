# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Extension lifecycle development

The lifecycle rebuild is not enabled in the production installer. Its [current state](../../specs/extensions/lifecycle.md), [plan](../../specs/extensions/archive/lifecycle-rebuild-plan.md), [ownership status](../../specs/extensions/archive/lifecycle-ownership.md), and [execution supervisor status](../../specs/extensions/lifecycle-supervisor.md) distinguish validated behavior from platform, durability, and migration blockers.

Run descriptor-ownership and process tests from this directory:

```sh
bun test --timeout 30000 test/extension/ownership.test.ts test/extension/lifecycle-process.test.ts
bun test --timeout 30000 test/extension/lifecycle-state.test.ts test/extension/execution-control.test.ts test/extension/execution-worker.test.ts test/extension/execution-supervisor.test.ts
OPENCODE_EXTENSION_ELECTRON_PROBE=1 bun test --timeout 30000 test/extension/ownership-electron.test.ts test/extension/execution-electron.test.ts
```

The Electron probes use isolated, windowless test apps and real utility processes; they do not launch the product main or access the user's extension registry. Root exit is reported separately from process-tree proof and does not authorize resource deletion. Ownership is currently validated only on macOS; other platforms fail explicitly rather than grant an unsupported lease. Native Node/Electron support uses pinned `fs-native-extensions` prebuilds, and Bun uses the same BSD flock protocol through libSystem.
