# Desktop release operations

## Scope and safety

Desktop builds and release preparation are separate manual operations, restricted to
`panyw5/opencode`. A build never creates a GitHub release. Release preparation defaults
to **artifact-only**; disabling that option creates an **unpublished draft** only.
No workflow publishes a release or overwrites an existing release or asset.

Use the same branch/ref and **exact commit SHA** for all three builds and the release
workflow. Do not advance that branch between runs; use a stable ref when necessary.
The release workflow checks its own `GITHUB_SHA`, not merely whether the three builds
agree with each other.

## Build

1. Dispatch `build-macos-x64.yml`, `build-macos-arm64.yml`, and
   `build-windows-desktop.yml` on that commit.
2. Leave each optional version empty to use the committed `VERSION`, or supply the
   same valid semver (an initial `v` is accepted) to all three. Invalid explicit
   versions fail rather than silently falling back. Windows uses `sync-version.ts`
   and exports the resulting `OPENCODE_VERSION` for filenames, sidecar, and updater
   metadata.
3. Wait for all runs to complete successfully. Windows must pass signing, real
   installation/restart smoke tests, installed sidecar version verification, and
   fork updater checks before uploading its manifest.
4. Record the three numeric **run IDs**, not job IDs or run numbers. Reruns must
   have a manifest corresponding to the run's current `run_attempt`.

Build artifacts are retained for 14 days. The exact names are
`opencode-desktop-macos-x64`, `opencode-desktop-macos-arm64`, and
`opencode-desktop-windows-x64`. Each includes its architecture-specific manifest.
Artifact expiration or duplicate matching artifact names fails release preparation.

Builds copy only the declared payloads into a clean staging directory before
creating a manifest. Builder output directories and external `.blockmap` files
are not release assets in this contract. macOS metadata is regenerated against
the final stapled DMG and the verified ZIP. Windows updates retain the existing
full-installer download behavior; missing external blockmaps may cause differential
download to fall back to a full download. That fallback has been inspected in the
installed updater source, not verified by a real Windows update in this iteration.

CI sidecar `--single` builds use `--skip-install` after the frozen native install,
avoiding a second all-OS/all-CPU dependency installation. Non-CI builds keep their
existing installation behavior. Native dependency availability remains a real
platform build validation requirement.

## Validate first, then create a draft

Dispatch `prepare-desktop-release.yml` with:

| Input                | Value                                               |
| -------------------- | --------------------------------------------------- |
| `version`            | Required exact semver, e.g. `v1.2.1`                |
| `macos_x64_run_id`   | Required successful manual x64 build run ID         |
| `macos_arm64_run_id` | Required successful manual arm64 build run ID       |
| `windows_run_id`     | Required successful manual Windows x64 build run ID |
| `artifact_only`      | Keep `true` for the initial validation              |

The script uses `gh` REST to check repository/head repository, workflow identity,
manual dispatch, completion/success, exact commit, and current attempt. Each exact
artifact is downloaded once into a separate staging directory. Missing manifests,
unexpected files, symlinks, unsafe basenames, version/provenance mismatch, size or
SHA-512 mismatch, invalid updater references, and asset collisions all fail closed.
Only verified files are copied into a flat asset directory. The shared helper merges
both validated macOS updater documents into one `latest-mac.yml`.

Download and inspect the consolidated `opencode-desktop-release-<input version>`
artifact and its small `provenance.json`. Consolidated artifacts are retained for
**3 days**, uncompressed. Artifact-only mode does not read or mutate release/tag state.

After authorized review, rerun preparation on the same commit and source run IDs with
`artifact_only: false`. Validation runs again before any write. An existing release
is always rejected (including an existing draft); no uploads are clobbered. An
existing lightweight or annotated tag must resolve to the exact verified commit.
If no tag exists, draft creation targets that commit explicitly. Draft creation and
asset upload are not transactional: a failed upload can leave a draft; inspect and
resolve it explicitly rather than rerunning with an overwrite option. Publishing,
cleanup, and any remote workflow dispatch require separate operator authorization.

Concurrency serializes identical version inputs without cancelling running jobs.
Use a consistent version spelling (`1.2.1` versus `v1.2.1`) when dispatching; GitHub
concurrency keys use the raw input. Build timeout is 180 minutes; preparation timeout
is 30 minutes. Checkout credentials are not persisted. Builds have `contents: read`;
preparation uses `actions: read` and `contents: write` with the scoped workflow token.

## Shared artifact helper integration contract

`script/desktop-release.ts` calls the shared helper, not a second YAML parser/merger.
It integrates the helper's concrete exports:

```ts
verifyManifest(directory, {
  repo, commit, version, platform, arch, runId, runAttempt,
}): Promise<Manifest>

mergeMacMetadata(
  x64Directory, arm64Directory, outputDirectory, x64Contract, arm64Contract,
): Promise<string>
```

`verifyManifest` validates the full manifest and updater contract, including
exact versioned platform/architecture filenames, SHA-512 and size, `files[].url`,
legacy `path`/`sha512`, rejection of traversal/absolute paths/external URLs and
unlisted references. `mergeMacMetadata` consumes both verified manifests/YAMLs,
write only `outputDirectory/latest-mac.yml`, retain both architectures' verified
entries, and rejects conflicting versions. The helper returns the verified manifest
for copying and rechecks both source directories during merging. API changes must be
adapted at this boundary; never bypass verification to make a legacy artifact pass.

The manifest format is schema version `1`, with `repo`, `commit`, `version`,
`platform` (`macos`/`windows`), `arch`, string `runId`, string `runAttempt`, and
`files: [{ basename, size, sha512 }]`. SHA-512 is base64, matching electron-updater.
Manifests list payload files including updater metadata, but not themselves.
The file is `manifest-<platform>-<arch>.json`.

## Migration and dependency blockers

Old artifacts without manifests are **not supported**. Rebuild all three targets
at the same commit using the new workflows; do not synthesize provenance for old runs
or accept artifacts from the former combined macOS workflow.

Bun is selected from root `package.json`; dependencies install using
`bun install --frozen-lockfile` before version synchronization. If the committed
lockfile is out of sync or platform installation fails, treat that as a blocker.
Do not regenerate the lockfile in CI or fall back to an unfrozen install. Shared
helper availability, sidecar build dependency behavior, genuine Windows installation,
macOS signing/notarization, and GitHub permissions require separate validation;
local static checks do not establish remote release readiness.
