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
