#!/usr/bin/env bash
# Apply drizzle + upstream migration pipeline against the isolated test fixture.
# NEVER writes production.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
assert_sqlite3

TARGET="$(abs_path "${1:-$TEST_DB}")"
PROD="$(abs_path "$PROD_DB")"
[[ -f "$TARGET" ]] || die "test DB not found: $TARGET"
assert_not_production "$TARGET"
[[ "$TARGET" != "$PROD" ]] || die "test DB path collides with production"

export OPENCODE_DB="$TARGET"
export OPENCODE_PRODUCTION_DB="$PROD"
echo_kv "OPENCODE_DB" "$OPENCODE_DB"
echo_kv "production (untouched)" "$PROD"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$REPO_ROOT"
bun "$SCRIPT_DIR/apply-test-db.ts"
