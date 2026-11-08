# Desktop package size

## Remote fonts

Remote builds keep all thirteen font choices. The default IBM/Blex Mono faces
retain their full Nerd Font character set. Alternative faces omit only private-use
characters also covered by the matching default weight; `monoFontFamily` already
includes IBM Plex Mono in every alternative's fallback chain. All other characters,
font names and OpenType layout features are retained. Fira Code stays intact because
the Claude theme also uses it without the settings fallback chain. Iosevka stays
intact because it has its own character set rather than the duplicated Nerd icons.

`packages/ui/src/assets/fonts-remote` contains generated, checked-in WOFF2 assets.
Normal desktop/web builds still use the original fonts. Only a build with
`VITE_OPENCODE_REMOTE=true` enables `packages/app/src/remote/font-build.ts`.
The plugin verifies SHA-256 hashes of the source and generated files and fails on
stale assets. Ordinary builds do not require Python, uv or a font download.

Regenerate after changing the original fonts:

```sh
uv run --with 'fonttools[woff]==4.60.1' python packages/ui/script/subset-remote-fonts.py
uv run --with 'fonttools[woff]==4.60.1' python packages/ui/script/subset-remote-fonts.py --check
```

The check verifies the exact retained character map and complete coverage through
the matching default fallback. The font loader's glob includes only catalog fonts,
not every unrelated WOFF2 in the source directory. It preserves lazy loading.

## Dependency pruning

Keep Effect versions separate during compilation: the host uses the catalog version
and OpenTunnel requires Effect 4.0.2. Do not override one with the other.
electron-vite bundles the source-only core/util/tunnel workspaces and the OpenTunnel
client/protocol. The installer excludes their redundant source trees and the tunnel
workspace's nested dependency copy. It also excludes root Effect's source and AI
documentation, but retains its runtime, metadata and license. Do not replace these
scoped exclusions with `!**/src/**/*`: some packages execute JavaScript from `src`.

The `afterPack` content audit checks the shipped entry points, absence of the excluded
trees, presence of Effect runtime/license and a 13 MB remote-font budget. It runs on
every platform. To inspect a built macOS app and compare it with a baseline:

```sh
bun packages/desktop/scripts/package-content.ts \
  '/path/after.app/Contents/Resources' '/path/before.app/Contents/Resources'
```

## Functionality checks

Run desktop tests from `packages/desktop` and web tests from `packages/app`:

```sh
bun test scripts/package-content.test.ts src/main/remote src/main/relaunch.test.ts
bun test --preload ./happydom.ts src/remote
```

The remote E2E harness accepts `--sidecar <packaged executable>` to test the actual
compiled CLI with a deterministic local provider and temporary database. With
`--permission --hold`, it verifies a harmless command approval and writes private
`package-worker-input.json` beside the browser invite. Read the generated sidecar log
after the fixture stops.

To test the pruned worker, build `scripts/packaged-remote-host.ts` with Bun's Node
target, ESM format and `electron` externalized. Launch that output in the development
Electron executable with the private fixture input path and the built app's Resources
directory as its arguments. The host runs the worker **inside the built ASAR**, pairs
over the actual public HTTPS tunnel, sends a message, checks the stored reply and
permission result, and verifies revocation. It writes `packaged-browser-invite.json`.
Add `--node-sidecar` to run `out/main/sidecar.js` from the same ASAR in an Electron
utility process instead of proxying to the fixture CLI. It creates a separate
temporary database and provider configuration, captures its backend logs, and
exercises the production Node backend together with the packaged remote worker.
The fixture permission policy is reconstructed explicitly because a config API
response can reorder last-match-wins permission rules.

The held fixture keeps all credentials in temporary memory/files and revokes its
QA identity on SIGINT/SIGTERM. Never use a host user's existing tunnel identity for
this check.

Use the existing development Electron on CDP 9222 for browser checks:

```sh
bun packages/desktop/scripts/remote-access-cdp.ts \
  /path/packaged-browser-invite.json --permission --fonts --general-only --no-screenshots
```

`--fonts` selects all thirteen real settings options and checks regular, bold and
shared-icon font loads, verifies a saved non-default font survives a reload, then
restores the original selection. The settings font effect always calls the loader
(which skips the built-in font), rather than comparing to a mutable store initializer.
`--no-screenshots` does not claim visual/physical-device verification.

## Measured baseline (2026-10-21)

macOS ARM64, Electron 41.2.1, version 1.18.60. Both local builds use the **same frozen
main/preload/renderer JavaScript and CLI executable**, dependencies and electron-builder
26.8.1 parameters. Only remote assets and package inclusion rules differ. Both use the
dev channel, ad-hoc signing, no notarization and no publishing. Do not compare these
numbers directly to a notarized release or another architecture.

| Component                             | Before (bytes) | After (bytes) | Saved (bytes) |
| ------------------------------------- | -------------: | ------------: | ------------: |
| DMG                                   |      242637708 |     210379428 |      32258280 |
| ZIP                                   |      233688567 |     201849466 |      31839101 |
| app.asar                              |      238361909 |     188563456 |      49798453 |
| Remote web                            |       59172062 |      36742877 |      22429185 |
| Remote fonts (included in remote web) |       34861868 |      12438328 |      22423540 |

Do not add the fonts row to the web row; fonts are a subset of web assets.
The generated font replacements alone shrink 23.33 MB to 1.54 MB. The remaining
remote-font footprint includes intact default/Fira/Iosevka faces and formula fonts.
Windows/x64 installer size and platform-native startup require their own builds.

Both builds include the completed appearance-settings refactor. A SHA-256 check
confirmed identical desktop build inputs and CLI bytes; a second check compared
all 18,203 retained, packed ASAR files byte-for-byte. A scan of 119 bundle imports
found no external imports of the pruned workspace/tunnel packages.

The final macOS ARM64 validation includes 53 desktop/packaging tests, 17 remote-web
tests, desktop/app typechecking, exact generated-font character-map coverage,
packaged app/Node-backend startup, isolated CLI messaging and command approval,
and public HTTPS remote-worker/browser checks. Browser checks use the compiled
assets from the final package through development Electron CDP 9222: pairing,
history, actual composer send, Allow once, persisted reply/tool output, all thirteen
fonts, reload restoration and settings bounds at phone/tablet/desktop widths.
The packaged Node-sidecar variant also passed public HTTPS pairing, permission
approval, harmless command execution, persisted assistant output and revocation;
the actual browser composer/Allow once flow and settings layout passed against
that production backend too. Its backend log was inspected directly.

## Conservative dependency pruning (2026-11-08)

The ARM64 draft `OpenCode_1.18.64_aarch64.dmg` is 210,262,013 bytes
(SHA-256 `0ea9add97babcf4f0eb790136af8540612957db68a5f28c041799ba428b7ec47`).
Version 1.18.63 was already 209,873,790 bytes; this draft grew by only
388,223 bytes, not a new jump to 200 MB.

`packages/desktop/scripts/package-pruning.ts` defines the additional exclusions.
It removes dependency declarations (`.d.ts`, `.d.mts`, `.d.cts`), the bundled
core workspace's redundant nested dependencies, and `src` trees from an explicit
list of SDKs with JavaScript runtime entry points. The exclusions also match
nested SDK copies. They do **not** remove arbitrary `src` trees, TypeScript
runtime packages, Zod's conditional source exports, licenses, native modules,
CLI executables, languages, fonts, or remote-web assets. Effect runtime and the
AJV/fast-json-stringify files used by generated runtime code remain available.
The existing `afterPack` audit rejects the same excluded paths. Tests exercise
electron-builder's real file matcher, not just the pattern strings.

### Same-input local comparison

Both builds use the same existing desktop `out`, CLI and remote-web bytes
(1,271 input files checked by SHA-256), dependency installation, Electron 41.2.1,
electron-builder 26.8.1, ARM64, dev channel, ad-hoc signing and UDZO DMG format.
No prebuild, formal signing, notarization or publishing ran. The baseline omits
only the new pruning patterns and their new audit; the after build enables them.
These are **local A/B numbers**, not a rebuilt notarized draft. Local main/sidecar
bytes are not identical to the published draft, so compare the two local builds
with each other, not either directly with the draft.

| Component                              | Before (bytes) | After (bytes) | Saved (bytes) |
| -------------------------------------- | -------------: | ------------: | ------------: |
| DMG                                    |      211426599 |     206353391 |       5073208 |
| ZIP                                    |      202843528 |     198011813 |       4831715 |
| app.asar                               |      191681442 |     163451503 |      28229939 |
| App (logical bytes, symlinks excluded) |      599983880 |     571753941 |      28229939 |
| Removed file payload                   |       26402343 |             0 |      26402343 |
| Remote web                             |       37155405 |      37155405 |             0 |

DMG savings are **2.40%**. ASAR savings include its smaller metadata header;
raw file savings must not be reported as compressed installer savings.
The comparison removed 6,930 files, added none, and verified every retained
file's content was unchanged (including unpacked native files). Every removal
matches the explicit pruning policy; the CLI and remote-web trees are unchanged.

Local comparison artifacts and logs are under
`.artifacts/package-pruning-TS9Xtu/` (ignored, not a release location).
To reproduce, package once per policy with frozen inputs into separate output
directories using electron-builder's API: `publish: "never"`, `mac.identity: "-"`,
`mac.notarize: false`, `dmg.sign: false`, and absolute entitlement paths. Preserve
all other options, and verify input hashes before and after both runs. Do not
invoke `package:mac` twice: its build/prebuild lifecycle can change inputs.

### Validation

- Package pruning/audit tests: 5 passed, including real builder-filter parity,
  nested SDK copies and preservation of runtime/source-exported modules. The
  loopback smoke helpers add 9 passing tests (14 total), including environment
  credential/config isolation and the sidecar's numeric-port start protocol.
- Backend/remote regression: 71 passed when the controller's Electron mock test
  is run in its own Bun process. A combined run failed with the existing
  `safeStorage` Electron export/mock conflict; it is not a pruning failure.
- Desktop `typecheck`: passed. The normal project scope is `src`; a separate
  strict `tsgo --ignoreConfig` check of the pruning/audit scripts, tests and
  electron-builder config also passed.
- The actual pruned app started with temporary onboarding data. CDP on isolated
  port 9237 verified the home, settings and provider views; backend logs confirmed
  `bundle-ready` and `listen-ready`. Port 9222 belonged to another project and
  was not touched. The first launch stalled after a Chromium network-service
  crash; a fresh isolated launch with `--disable-gpu` succeeded. This does not
  establish GPU-enabled startup reliability.
- Windows/Linux and macOS x64 were not rebuilt in this comparison. Their normal
  packaging still runs the shared audit; native startup needs platform-specific
  verification. No production provider credentials or public tunnel were used.

Run the focused checks from `packages/desktop`:

```sh
bun test scripts/package-content.test.ts scripts/packaged-size-smoke.test.ts
bun test src/main/remote/controller.test.ts
bun test src/main/remote/gateway.test.ts src/main/remote/ipc-origin.test.ts \
  src/main/remote/storage.test.ts src/main/server.test.ts src/main/relaunch.test.ts
bun run typecheck
```

The loopback fixture is a development tool, not part of the packaged application.
Build it outside the empty runtime-artifacts directory and run it with the
existing development Electron binary:

```sh
bun build --target=node --format=esm --external=electron \
  packages/desktop/scripts/packaged-size-smoke.ts \
  --outfile /path/to/tools/packaged-size-smoke.mjs
packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  /path/to/tools/packaged-size-smoke.mjs \
  '/path/to/built.app/Contents/Resources' /path/to/new-empty-smoke-artifacts
```
