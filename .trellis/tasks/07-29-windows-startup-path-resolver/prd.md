# Startup paths

Centralize Windows desktop and CLI launch decisions.

---

## Define scope

Refactor the Windows desktop and CLI startup path flow without changing unrelated product behavior. The sidecar must use the CLI data home at `~/.local/share/opencode`, while desktop-only cache and state may remain under Electron `userData`.

Include `XDG_DATA_HOME`, `Global.Path.data`, `sidecarDataHome`, `desktopXdgEnv`, the sidecar default workspace cwd, SDK directory header/query normalization, route selection, and directory-keyed UI stores. Preserve existing non-Windows behavior unless a shared boundary requires the same fix.

Do not move cache or state into the shared CLI data directory. Do not rewrite persisted sessions or broaden this work into a general workspace redesign.

---

## Establish architecture

Create one startup/path resolver with explicit inputs for platform, home directory, desktop `userData`, inherited environment, and launch cwd. It must return the canonical sidecar data directory, desktop-private cache/state locations, sidecar environment, and default workspace directory.

Make all desktop startup callers consume that resolver instead of independently deciding `XDG_DATA_HOME`, data paths, or cwd. The CLI remains the authority for `Global.Path.data`; the desktop resolver must produce the compatible data-home environment before the sidecar starts.

Define two distinct directory transformations at clear boundaries. Normalize values sent over SDK headers and query strings to the server wire format, but canonicalize directory store keys once at the store boundary and use that key for both reads and writes.

Never use wire normalization as a replacement for store-key canonicalization. The `D:\\chat` to `D:/chat` regression showed that writing session results under a normalized key while the sidebar reads the original key splits one directory into two stores.

---

## Identify files

- `packages/desktop/src/main/server-env.ts`: replace independent data-home and environment decisions with the resolver
- `packages/desktop/src/main/server.ts`: consume the resolved sidecar environment and default cwd
- `packages/desktop/src/main/sidecar.ts`: consume the resolved sidecar environment and default cwd
- `packages/desktop/src/main/index.ts`: remove duplicate launch-path decisions and retain desktop-private cache/state ownership
- `packages/desktop/src/main/logging.ts` and `packages/desktop/src/main/migrate.ts`: verify data-path consumers use the intended shared or private location
- `packages/opencode/src/global/index.ts`: document and verify the CLI `Global.Path.data` contract used by the sidecar
- `packages/sdk/js/src/v2/client.ts`: retain wire-only directory normalization for headers and query values
- `packages/app/src/context/sdk.tsx`: apply one canonical key at the SDK/store boundary
- `packages/app/src/context/global-sync.tsx`: use the same canonical key for session-result writes and sidebar reads
- `packages/app/src/pages/layout.tsx`: preserve an explicit initial route and prevent autoselection from replacing it
- `packages/opencode/src/project/project.ts` or the current project resolver: retain `ProjectID.global` for non-Git directories
- `packages/opencode/src/session/session.ts` and `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`: support directory-filtered lists when the project id is global
- `packages/desktop/src/main/server-env.test.ts`, `packages/app/src/context/global-sync.test.tsx` or nearest coverage, `packages/app/src/pages/layout.test.tsx` or nearest coverage, and session/API tests: add focused regression coverage

Confirm exact project-resolver and UI test paths during implementation because their current names may change. Keep the resolver small and owned by desktop startup rather than duplicating it in renderer code.

---

## Accept behavior

- [ ] On Windows, desktop sidecars and the CLI resolve persistent OpenCode data to `~/.local/share/opencode` through `XDG_DATA_HOME` and `Global.Path.data`.
- [ ] Desktop cache and state remain independently configurable under desktop `userData` and are not accidentally treated as shared CLI data.
- [ ] Sidecar startup has one resolved environment and one resolved default workspace cwd, with no conflicting decisions in `server.ts`, `sidecar.ts`, or startup bootstrap.
- [ ] SDK directory headers and query parameters use the accepted wire format without changing the canonical key used by app stores.
- [ ] A Windows directory supplied as `D:\\chat` reads and writes session data through one store identity, so sidebar and session-result state remain synchronized.
- [ ] An explicit initial directory route remains selected after asynchronous workspace loading; autoselection only runs when no explicit route exists.
- [ ] A non-Git directory still resolves to `ProjectID.global`, and session lists can filter that global project by the requested directory.
- [ ] Existing macOS and Linux startup behavior, CLI data paths, and Git-project session filtering remain covered by regression tests.

---

## Stage delivery

1. Map every current startup and path decision, then write resolver tests for Windows data, private cache/state, inherited environment, and default cwd.
2. Introduce the resolver and migrate desktop sidecar, server, logging, migration, and bootstrap callers without changing wire or UI behavior.
3. Establish directory canonicalization boundaries in the SDK and app stores, then add the `D:\\chat` read/write regression test.
4. Protect explicit route selection and add route-autoselection coverage for delayed workspace loading.
5. Add global-project directory-filtered session-list coverage at the session and HTTP API layers.
6. Run targeted desktop, app, SDK, and server tests, followed by the relevant typecheck and lint commands.
