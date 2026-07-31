#!/usr/bin/env bash
# Shared helpers for session-db migration task scripts.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer Trellis task fixtures when present; allow override for mergeable package scripts.
_REPO_ROOT="$(cd "$SCRIPTS_DIR/../../../.." && pwd 2>/dev/null || true)"
_DEFAULT_TASK="$_REPO_ROOT/.trellis/tasks/07-30-session-db-migration-upgrade"
TASK_DIR="${OPENCODE_MIGRATION_TASK_DIR:-}"
if [[ -z "$TASK_DIR" ]]; then
  if [[ -d "$_DEFAULT_TASK" ]]; then
    TASK_DIR="$_DEFAULT_TASK"
  else
    # Fallback: when scripts live inside the Trellis task directory
    TASK_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
  fi
fi
FIXTURES_DIR="${OPENCODE_MIGRATION_FIXTURES_DIR:-$TASK_DIR/fixtures}"
REPORTS_DIR="${OPENCODE_MIGRATION_REPORTS_DIR:-$TASK_DIR/reports}"
TEST_DB="${OPENCODE_MIGRATION_TEST_DB:-$FIXTURES_DIR/opencode-migration-test.db}"
PROD_DB="${OPENCODE_PRODUCTION_DB:-$HOME/.local/share/opencode/opencode.db}"

mkdir -p "$FIXTURES_DIR" "$REPORTS_DIR"

abs_path() {
  local p="$1"
  if [[ "$p" = /* ]]; then
    printf '%s\n' "$p"
  else
    printf '%s\n' "$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
  fi
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

assert_not_production() {
  local target
  target="$(abs_path "$1")"
  local prod
  prod="$(abs_path "$PROD_DB")"
  if [[ "$target" == "$prod" ]]; then
    die "refusing to operate on production DB: $target"
  fi
  # Also refuse common production names under data dir without explicit test prefix
  if [[ "$(basename "$target")" == "opencode.db" && "$target" == "$prod" ]]; then
    die "refusing production basename at production path"
  fi
}

assert_sqlite3() {
  command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 CLI is required"
}

echo_kv() {
  printf '%-32s %s\n' "$1" "$2"
}
