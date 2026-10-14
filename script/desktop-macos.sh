#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/packages/desktop/dist"
log() { printf '[desktop-macos] %s\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

# Retry only recognizable transport/service failures, never signature or policy errors.
retry_transient() {
  local attempt=1 delay=20 status output
  output="$(mktemp "$RUNNER_TEMP/macos-retry.XXXXXX")"
  while true; do
    log "ticket check attempt=$attempt/4 command=$1"
    if "$@" > "$output" 2>&1; then
      cat "$output"
      rm -f "$output"
      return 0
    else
      status=$?
    fi
    cat "$output"
    if [ "$attempt" -ge 4 ] || ! grep -Eiq 'NSURLError|(-1005|-1001|-1009)|timed out|connection (reset|lost)|Service Unavailable|HTTP[^0-9]*50[234]|CloudKit.*(unavailable|network)' "$output"; then
      rm -f "$output"
      return "$status"
    fi
    log "transient ticket failure status=$status; retry in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

configure_arch() {
  case "${ARCH:-}" in
    x64) MACH_ARCH=x86_64; DMG_ARCH=x64; EXPECTED_TARGET=x86_64-apple-darwin ;;
    arm64) MACH_ARCH=arm64; DMG_ARCH=aarch64; EXPECTED_TARGET=aarch64-apple-darwin ;;
    *) fail 'ARCH must be x64 or arm64' ;;
  esac
  [ "$RUST_TARGET" = "$EXPECTED_TARGET" ] || fail 'RUST_TARGET does not match ARCH'
  : "${OPENCODE_VERSION:?}"
  DMG="$DIST/OpenCode_${OPENCODE_VERSION}_${DMG_ARCH}.dmg"
  ZIP="$DIST/opencode-desktop-mac-${ARCH}.zip"
}

find_app() {
  local candidates=()
  shopt -s nullglob
  candidates=("$DIST"/mac*/OpenCode.app)
  [ "${#candidates[@]}" -eq 1 ] || fail "expected one packaged App; found ${#candidates[@]}"
  APP="${candidates[0]}"
}

notarize() {
  local asset="$1" result id status
  result="$(mktemp "$RUNNER_TEMP/macos-notary.XXXXXX")"
  log "notary submission asset=$(basename "$asset") timeout=60m (no resubmission retries)"
  if ! xcrun notarytool submit "$asset" --keychain "$APPLE_KEYCHAIN" \
    --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait --timeout 60m --output-format json > "$result"; then
    cat "$result"
    rm -f "$result"
    fail 'notary submission failed or timed out'
  fi
  id="$(plutil -extract id raw -o - "$result")"
  status="$(plutil -extract status raw -o - "$result")"
  log "notary submission id=$id status=$status"
  rm -f "$result"
  [ "$status" = Accepted ] || fail "notary submission not accepted: $id"
}

verify_app() {
  local app="$1" plist executable version sidecar updater actual
  plist="$app/Contents/Info.plist"
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
  sidecar="$app/Contents/Resources/sidecars/opencode-cli-${RUST_TARGET}"
  updater="$app/Contents/Resources/app-update.yml"
  log "verify App=$app version=$version expected=$OPENCODE_VERSION arch=$MACH_ARCH"
  [ "$version" = "$OPENCODE_VERSION" ] || fail 'App version mismatch'
  [ -x "$sidecar" ] || fail 'missing executable sidecar'
  for binary in "$app/Contents/MacOS/$executable" "$sidecar"; do
    actual="$(lipo -archs "$binary")"
    log "Mach-O binary=$binary architecture=$actual"
    [ "$actual" = "$MACH_ARCH" ] || fail 'Mach-O architecture mismatch'
  done
  actual="$("$sidecar" --version)"
  log "sidecar version=$actual"
  [ "$actual" = "$OPENCODE_VERSION" ] || fail 'sidecar version mismatch'
  grep -Eq '^owner:[[:space:]]*panyw5[[:space:]]*$' "$updater"
  grep -Eq '^repo:[[:space:]]*opencode[[:space:]]*$' "$updater"
  ! grep -q 'anomalyco' "$updater"
  codesign --verify --deep --strict --verbose=2 "$app"
  retry_transient spctl --assess --type execute --verbose=4 "$app"
  retry_transient xcrun stapler validate "$app"
}

case "${1:-}" in
  import)
    log 'import Developer ID certificate and store notary credentials (values suppressed)'
    : "${CERTIFICATE_BASE64:?}" "${CERTIFICATE_PASSWORD:?}" "${APPLE_ID:?}" "${APPLE_APP_SPECIFIC_PASSWORD:?}" "${APPLE_TEAM_ID:?}"
    KEYCHAIN_PATH="$RUNNER_TEMP/opencode-signing.keychain-db"
    KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"
    printf '::add-mask::%s\n' "$KEYCHAIN_PASSWORD"
    CERTIFICATE_PATH="$RUNNER_TEMP/developer-id.p12"
    trap 'rm -f "$CERTIFICATE_PATH"' EXIT
    printf '%s' "$CERTIFICATE_BASE64" | base64 --decode > "$CERTIFICATE_PATH"
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
    security set-keychain-settings -lut 10800 "$KEYCHAIN_PATH"
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
    security import "$CERTIFICATE_PATH" -P "$CERTIFICATE_PASSWORD" -t cert -f pkcs12 -k "$KEYCHAIN_PATH" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" > /dev/null
    security list-keychains -d user -s "$KEYCHAIN_PATH" "$HOME/Library/Keychains/login.keychain-db"
    security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep -F "Developer ID Application: $CSC_NAME"
    xcrun notarytool store-credentials "$NOTARY_PROFILE" --keychain "$KEYCHAIN_PATH" \
      --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" > /dev/null
    printf 'CSC_KEYCHAIN=%s\nAPPLE_KEYCHAIN=%s\nAPPLE_KEYCHAIN_PROFILE=%s\n' "$KEYCHAIN_PATH" "$KEYCHAIN_PATH" "$NOTARY_PROFILE" >> "$GITHUB_ENV"
    log 'signing and notary credentials ready'
    ;;
  build)
    configure_arch
    cd "$ROOT/packages/desktop"
    log "build signed App arch=$ARCH version=$OPENCODE_VERSION"
    log "Node build budget NODE_OPTIONS=${NODE_OPTIONS:-default}"
    node -e 'console.log(`[desktop-macos] node=${process.version} arch=${process.arch} heapLimitMiB=${Math.round(require("node:v8").getHeapStatistics().heap_size_limit / 1048576)} totalMemoryMiB=${Math.round(require("node:os").totalmem() / 1048576)}`)'
    # Dist contains only build outputs; never allow a previous App/DMG into this run.
    rm -rf "$DIST"
    bun run build
    # Disable builder's unbounded automatic notary wait; explicitly submit the App below.
    # A distributable target is required: --dir omits app-update.yml. Generate a
    # temporary ZIP so builder embeds the updater config before signing the App.
    bun x --no-install electron-builder --mac zip "--$ARCH" --publish never --config electron-builder.config.ts -c.mac.notarize=false
    find_app
    APP_ZIP="$RUNNER_TEMP/opencode-notary-app.zip"
    log 'submit App ZIP container, then staple the accepted ticket to App'
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$APP_ZIP"
    notarize "$APP_ZIP"
    rm -f "$APP_ZIP"
    retry_transient xcrun stapler staple "$APP"
    verify_app "$APP"
    log 'discard pre-staple ZIP and metadata; regenerate from notarized App'
    rm -f "$ZIP" "$ZIP.blockmap" "$DIST/latest-mac.yml"
    log 'package previously signed and notarized App into DMG and updater ZIP'
    bun x --no-install electron-builder --mac "--$ARCH" --prepackaged "$APP" --publish never --config electron-builder.config.ts -c.mac.notarize=false
    shopt -s nullglob
    dmgs=("$DIST"/*.dmg)
    [ "${#dmgs[@]}" -eq 1 ] || fail "expected one DMG; found ${#dmgs[@]}"
    mv "${dmgs[0]}" "$DMG"
    notarize "$DMG"
    retry_transient xcrun stapler staple "$DMG"
    # The shared artifact helper validates ZIP bytes and rewrites the final DMG
    # filename/hash after stapling. Keep one metadata parser and implementation.
    log 'stage builder metadata for shared final-byte hash validation'
    cp "$DIST/latest-mac.yml" "$DIST/latest-mac-${ARCH}.yml"
    log 'App and DMG notarization complete'
    ;;
  verify)
    configure_arch
    [ "$(< "$ROOT/VERSION")" = "$OPENCODE_VERSION" ] || fail 'source VERSION mismatch'
    find_app
    verify_app "$APP"
    log "verify final DMG=$DMG"
    hdiutil verify "$DMG"
    codesign --verify --strict --verbose=2 "$DMG"
    retry_transient xcrun stapler validate "$DMG"
    retry_transient spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
    test -f "$ZIP"
    log "verify updater ZIP=$ZIP"
    unzip -t "$ZIP"
    python3 "$ROOT/script/desktop-zip.py" "$ZIP"
    ZIP_DIR="$(mktemp -d "$RUNNER_TEMP/macos-zip.XXXXXX")"
    trap 'rm -rf "$ZIP_DIR"' EXIT
    ditto -x -k "$ZIP" "$ZIP_DIR"
    verify_app "$ZIP_DIR/OpenCode.app"
    log 'all packaged version, architecture, updater owner, signing and notarization checks passed'
    ;;
  cleanup)
    log 'remove temporary signing material'
    rm -f "$RUNNER_TEMP/developer-id.p12" "$RUNNER_TEMP/opencode-notary-app.zip"
    KEYCHAIN_PATH="$RUNNER_TEMP/opencode-signing.keychain-db"
    if [ -f "$KEYCHAIN_PATH" ]; then security delete-keychain "$KEYCHAIN_PATH"; fi
    ;;
  *) fail 'usage: desktop-macos.sh import|build|verify|cleanup' ;;
esac
