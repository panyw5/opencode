#!/usr/bin/env bash
# Launch opencode (or any command) with OPENCODE_DB forced to the isolated test fixture.
# Usage:
#   ./open-with-test-db.sh                 # print export instructions
#   ./open-with-test-db.sh bun run dev     # run command with env
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

TEST="$(abs_path "$TEST_DB")"
PROD="$(abs_path "$PROD_DB")"
[[ -f "$TEST" ]] || die "test DB missing; run snapshot-test-db.sh first: $TEST"
assert_not_production "$TEST"
[[ "$TEST" != "$PROD" ]] || die "test DB path collides with production"

export OPENCODE_DB="$TEST"
# Belt-and-suspenders: refuse if someone overrides later in same shell incorrectly
echo_kv "OPENCODE_DB" "$OPENCODE_DB"
echo_kv "production (untouched)" "$PROD"

if [[ $# -eq 0 ]]; then
  echo
  echo "Shell exports ready. Example:"
  echo "  export OPENCODE_DB=\"$TEST\""
  echo "  cd <worktree> && bun run dev"
  exit 0
fi

# Guard: refuse commands that embed production path as OPENCODE_DB
if [[ "${OPENCODE_DB:-}" == "$PROD" ]]; then
  die "OPENCODE_DB points at production; abort"
fi

exec "$@"
