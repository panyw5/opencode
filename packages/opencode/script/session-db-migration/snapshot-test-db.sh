#!/usr/bin/env bash
# Create/refresh isolated test DB from production via sqlite3 .backup (read-only on source).
# Never writes to production.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
assert_sqlite3

PROD="$(abs_path "$PROD_DB")"
TEST="$(abs_path "$TEST_DB")"

[[ -f "$PROD" ]] || die "production DB not found: $PROD"
assert_not_production "$TEST"

echo "=== Snapshot production → test DB ==="
echo_kv "production (read-only)" "$PROD"
echo_kv "test (writable)" "$TEST"

rm -f "$TEST" "${TEST}-wal" "${TEST}-shm"
# .backup consolidates WAL safely without needing app shutdown in most cases
sqlite3 "$PROD" ".backup '$TEST'"
rm -f "${TEST}-wal" "${TEST}-shm"

echo "=== Verify snapshot ==="
integrity="$(sqlite3 "$TEST" 'PRAGMA integrity_check;')"
echo_kv "integrity_check" "$integrity"
[[ "$integrity" == "ok" ]] || die "snapshot integrity_check failed: $integrity"

sessions="$(sqlite3 "$TEST" 'SELECT count(*) FROM session;')"
messages="$(sqlite3 "$TEST" 'SELECT count(*) FROM message;')"
parts="$(sqlite3 "$TEST" 'SELECT count(*) FROM part;')"
echo_kv "sessions" "$sessions"
echo_kv "messages" "$messages"
echo_kv "parts" "$parts"
echo_kv "size" "$(du -h "$TEST" | awk '{print $1}')"

# Write a tiny meta file for assess scripts
cat > "$FIXTURES_DIR/snapshot-meta.txt" <<EOF
snapshot_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
production=$PROD
test_db=$TEST
sessions=$sessions
messages=$messages
parts=$parts
integrity=$integrity
EOF

echo "OK: test DB ready. Use:"
echo "  export OPENCODE_DB=\"$TEST\""
