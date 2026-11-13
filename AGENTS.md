# Repo

push ONLY to my fork `panyw5/opencode`, except for extension releases to `panyw5/open-extensions` as permitted below.

run github action only with my fork `panyw5/opencode`, except for extension releases to `panyw5/open-extensions` as permitted below.

## Extension release exception (panyw5/open-extensions)

- Publishing extensions from `packages/extensions/` to `panyw5/open-extensions` is explicitly allowed.
- For extension releases to `panyw5/open-extensions`, you may push extension source and release metadata (including `stable.json`), create tags and GitHub Releases, and upload extension packages (`.tgz`).
- `script/extension-publish.ts <name>` automates this flow (build → sync source → pack → Release asset → `stable.json` → push).
- You may run GitHub Actions in `panyw5/open-extensions` to build, test, or publish extensions.
- This exception does not permit pushing the main OpenCode project to any repository other than `panyw5/opencode`, or publishing to any other extension repository.

# MANDATORY RULES

There are several opencode instances:

- installed desktop app (`/applications/opencode.app`)
- installed official cli (`/opt/homebrew/bin/opencode`)
- development electron app for testing (`bun run dev:desktop`)

## Using the development electron app

- Run **frontend** tests using CDP 9222: you can control **electron** app, spawn one if not running
  **VERIFY** if there is electron app running **before** launching
- DO NOT shut down the installed opencode app (`/applications/opencode.app`).
- [CRITICAL] Run CDP verification after your edit!!!
- CDP helper (dev renderer only, does not launch or quit apps):
  ```
  bun packages/desktop/scripts/cdp.ts targets
  bun packages/desktop/scripts/cdp.ts info
  bun packages/desktop/scripts/cdp.ts eval 'document.title'
  bun packages/desktop/scripts/cdp.ts click 'New session'
  bun packages/desktop/scripts/cdp.ts screenshot /tmp/opencode-cdp.png
  ```
- TRAP: never call `window.api.browser.acquireDisplay()` / `updateDisplay()` / `releaseDisplay()` over CDP. The renderer's browser panel owns a display lease; acquiring steals it and releasing zeroes it, so every subsequent frontend frame is rejected as stale and web pages navigate but never show. Verify with `getDisplayState()`/`getState()`/`capturePreview()` or browser.log instead. Recovery if poisoned: `location.reload()`.

## Keybinds are user-configurable — never assume source defaults

Keybinds registered in code (e.g. `keybind: "mod+shift+s"` in `pages/layout.tsx`) are DEFAULTS only.
The user can remap any command in Settings, and this machine has (e.g. `session.new` → `mod+n`, `sidebar.toggle` → `mod+[`).

- Effective keybind = `settings.keybinds[commandId] ?? source default` (resolved by `bind()` in `packages/app/src/context/command.tsx`).
- BEFORE dispatching keyboard shortcuts over CDP (or reasoning about "why did shortcut X do nothing"), read the actual overrides:
  ```
  bun packages/desktop/scripts/cdp.ts eval 'window.api.storeGet("default.dat", "settings.v3").then(v => JSON.parse(v).keybinds)'
  ```
- Desktop persistence goes through the Electron IPC bridge (`window.api.storeGet/storeKeys`), NOT localStorage — localStorage is a dead end.
- TRAP: the persisted command catalog (`command.catalog.v1` in the same storage) lists DEFAULT keybinds only, never user overrides. Do not trust it for actual bindings.
- A remapped- or unbound-command keypress dispatches nothing and logs nothing; `mod+x` defaults may legitimately do nothing.

Obey the following rules at all times:

- Read backend logs YOURSELF!!!! You are forbidden to ask user to read backend log for you!!!!
- When fixing bug: ADD LOGS AT EVERY STEP!!!! ASSUME YOU ARE MORON, AND NEED LOGS TO DO ANY DEBUGGING
- YOU yourself must perform SIDECAR functionality testing. YOU ARE FORBIDDEN to ask user to perform sidecar functionality testing for you!!!!
  - SEND MESSAGES YOURSELF
  - VERIFY RECEIVED MESSAGES YOURSELF
  - ADD LOGS YOURSELF
- If the user provided a project path and a session id: **look up** the session database to understand the actual situation and identify the problem, BEFORE reading and modifying the codebase

## dev:desktop backend caveat

`bun run dev:desktop` predev copies the sidecar from `packages/opencode/dist/opencode-darwin-arm64/bin/opencode` — a PREBUILT binary, not source. Backend changes under `packages/opencode/src` are NOT picked up on restart; run `bun run script/build.ts` in packages/opencode first, then restart dev:desktop.
