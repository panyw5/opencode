#!/usr/bin/env bash
# Assess session SQLite DB quality. Writes markdown report under reports/.
# Default target: fixtures/opencode-migration-test.db
# NEVER defaults to production; pass --allow-production only for read-only audit.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"
assert_sqlite3

LABEL="baseline"
ALLOW_PROD=0
TARGET="$TEST_DB"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      TARGET="$2"
      shift 2
      ;;
    --label)
      LABEL="$2"
      shift 2
      ;;
    --allow-production)
      ALLOW_PROD=1
      shift
      ;;
    -*)
      die "unknown flag: $1"
      ;;
    *)
      LABEL="$1"
      shift
      ;;
  esac
done

TARGET="$(abs_path "$TARGET")"
PROD="$(abs_path "$PROD_DB")"
[[ -f "$TARGET" ]] || die "DB not found: $TARGET"

if [[ "$TARGET" == "$PROD" && "$ALLOW_PROD" -ne 1 ]]; then
  die "refusing production DB without --allow-production (read-only audit only)"
fi
if [[ "$TARGET" != "$PROD" ]]; then
  assert_not_production "$TARGET"
fi

REPORT="$REPORTS_DIR/quality-${LABEL}.md"
TMPDIR_ASSESS="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ASSESS"' EXIT

q() {
  sqlite3 "$TARGET" "$1"
}

echo "=== Assessing $TARGET (label=$LABEL) ==="

integrity="$(q 'PRAGMA integrity_check;')"
fk="$(q 'PRAGMA foreign_key_check;' || true)"
fk_count="$(printf '%s\n' "$fk" | sed '/^$/d' | wc -l | tr -d ' ')"

# counts
count_table() {
  local t="$1"
  if q "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1;" | grep -q 1; then
    q "SELECT count(*) FROM \"$t\";"
  else
    echo "MISSING"
  fi
}

sessions="$(count_table session)"
messages="$(count_table message)"
parts="$(count_table part)"
session_message="$(count_table session_message)"
session_input="$(count_table session_input)"
events="$(count_table event)"
fts="$(count_table session_content_fts)"
scheduled="$(count_table scheduled_task)"
project_directory="$(count_table project_directory)"
credential="$(count_table credential)"
permission="$(count_table permission)"

# permission shape
perm_cols="$(q "PRAGMA table_info(permission);" 2>/dev/null || true)"
perm_model="missing"
if printf '%s' "$perm_cols" | grep -q '|data|'; then
  perm_model="fork-json-blob"
elif printf '%s' "$perm_cols" | grep -q '|action|'; then
  perm_model="upstream-row-level"
elif [[ -n "$perm_cols" ]]; then
  perm_model="unknown"
fi

# required fork list indexes
required_indexes=(
  session_project_parent_time_idx
  session_project_directory_parent_time_idx
  session_project_path_parent_time_idx
  session_workspace_parent_time_idx
)
index_status=""
missing_indexes=0
for idx in "${required_indexes[@]}"; do
  if q "SELECT 1 FROM sqlite_master WHERE type='index' AND name='$idx' LIMIT 1;" | grep -q 1; then
    index_status+="- [x] \`$idx\` present"$'\n'
  else
    index_status+="- [ ] \`$idx\` **MISSING**"$'\n'
    missing_indexes=$((missing_indexes + 1))
  fi
done

# migration ledgers
drizzle_names="$(q "SELECT COALESCE(name,'(null)') FROM __drizzle_migrations ORDER BY created_at;" 2>/dev/null || echo '(no __drizzle_migrations)')"
migration_ids="$(q "SELECT id FROM migration ORDER BY id;" 2>/dev/null || echo '(no migration table)')"

# ledger honesty: permission rewrite claimed?
claimed_permission_rewrite=0
if q "SELECT 1 FROM migration WHERE id IN ('20260601202201_amazing_prowler','20260602002951_lowly_union_jack') LIMIT 1;" 2>/dev/null | grep -q 1; then
  claimed_permission_rewrite=1
fi
ledger_permission_note="ok"
if [[ "$claimed_permission_rewrite" -eq 1 && "$perm_model" == "fork-json-blob" ]]; then
  # Fork policy (Phase 1): keep project-scoped JSON blob. Upstream ids
  # amazing_prowler / lowly_union_jack are intentional no-ops in upstream-migration.ts.
  ledger_permission_note="ok (fork policy: keep json-blob; amazing_prowler/lowly_union_jack intentional no-ops)"
elif [[ "$claimed_permission_rewrite" -eq 1 && "$perm_model" == "upstream-row-level" ]]; then
  ledger_permission_note="WARN: ledger claims permission rewrite and live table is upstream-row-level (fork expects json-blob; repairPermissionSchema should fix on open)"
fi

# session_message seq
sm_cols="$(q "PRAGMA table_info(session_message);" 2>/dev/null || true)"
has_seq=0
printf '%s' "$sm_cols" | grep -q '|seq|' && has_seq=1

# tables list
tables="$(q "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")"

# PASS/FAIL
pass=1
fail_reasons=()
[[ "$integrity" == "ok" ]] || { pass=0; fail_reasons+=("integrity_check=$integrity"); }
# FK check: warn only if many; production may have historical orphans — report count
if [[ "$sessions" == "MISSING" || "$messages" == "MISSING" || "$parts" == "MISSING" ]]; then
  pass=0
  fail_reasons+=("core tables missing")
fi
if [[ "$has_seq" -ne 1 && "$session_message" != "MISSING" ]]; then
  pass=0
  fail_reasons+=("session_message.seq missing")
fi
if [[ "$missing_indexes" -gt 0 ]]; then
  # indexes are fork feature — fail if product expects them
  pass=0
  fail_reasons+=("missing $missing_indexes list indexes")
fi

verdict="PASS"
[[ "$pass" -eq 1 ]] || verdict="FAIL"

# Compare to baseline counts if present
baseline_file="$REPORTS_DIR/quality-baseline.counts"
count_file="$REPORTS_DIR/quality-${LABEL}.counts"
cat > "$count_file" <<EOF
sessions=$sessions
messages=$messages
parts=$parts
session_message=$session_message
event=$events
EOF

count_delta=""
if [[ "$LABEL" == "baseline" ]]; then
  # count_file already is quality-baseline.counts when LABEL=baseline
  if [[ "$count_file" != "$baseline_file" ]]; then
    cp "$count_file" "$baseline_file"
  fi
elif [[ -f "$baseline_file" ]]; then
  # shellcheck disable=SC1090
  source "$baseline_file"
  b_sessions="${sessions:-0}"
  b_messages="${messages:-0}"
  b_parts="${parts:-0}"
  b_session_message="${session_message:-0}"
  b_event="${event:-0}"
  # restore current counts (source overwrote)
  # shellcheck disable=SC1090
  source "$count_file"
  count_delta+="| metric | baseline | current | delta |\n"
  count_delta+="|---|---:|---:|---:|\n"
  for key in sessions messages parts session_message event; do
    b_var="b_${key}"
    b="${!b_var:-0}"
    c="${!key:-0}"
    if [[ "$c" == "MISSING" ]]; then
      d="MISSING"
      pass=0
      fail_reasons+=("$key missing vs baseline")
    else
      d=$((c - b))
      if [[ "$key" == "sessions" || "$key" == "messages" || "$key" == "parts" ]] && [[ "$d" -lt 0 ]]; then
        pass=0
        fail_reasons+=("$key count decreased by $((-d))")
        verdict="FAIL"
      fi
    fi
    count_delta+="| $key | $b | $c | $d |\n"
  done
fi

{
  echo "# DB Quality Report — \`$LABEL\`"
  echo
  echo "- **Generated:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- **DB:** \`$TARGET\`"
  echo "- **Production path:** \`$PROD\`"
  echo "- **Is production file:** $([[ "$TARGET" == "$PROD" ]] && echo YES || echo no)"
  echo "- **Verdict:** **$verdict**"
  if [[ ${#fail_reasons[@]} -gt 0 ]]; then
    echo "- **Fail reasons:**"
    for r in "${fail_reasons[@]}"; do echo "  - $r"; done
  fi
  if [[ -n "$ledger_permission_note" && "$ledger_permission_note" != "ok" ]]; then
    echo "- **Ledger note:** $ledger_permission_note"
  fi
  echo
  echo "## Integrity"
  echo
  echo "| check | result |"
  echo "|---|---|"
  echo "| integrity_check | \`$integrity\` |"
  echo "| foreign_key_check rows | $fk_count |"
  echo
  if [[ "$fk_count" != "0" ]]; then
    echo "<details><summary>foreign_key_check sample (first 20)</summary>"
    echo
    echo '```'
    printf '%s\n' "$fk" | head -20
    echo '```'
    echo
    echo "</details>"
    echo
  fi
  echo "## Row counts"
  echo
  echo "| table | count |"
  echo "|---|---:|"
  echo "| session | $sessions |"
  echo "| message | $messages |"
  echo "| part | $parts |"
  echo "| session_message | $session_message |"
  echo "| session_input | $session_input |"
  echo "| event | $events |"
  echo "| session_content_fts | $fts |"
  echo "| scheduled_task | $scheduled |"
  echo "| project_directory | $project_directory |"
  echo "| credential | $credential |"
  echo "| permission | $permission |"
  echo
  if [[ -n "$count_delta" ]]; then
    echo "## Delta vs baseline"
    echo
    echo -e "$count_delta"
    echo
  fi
  echo "## Permission model"
  echo
  echo "- Detected: **$perm_model**"
  echo
  echo '```'
  printf '%s\n' "$perm_cols"
  echo '```'
  echo
  echo "## session_message.seq"
  echo
  echo "- present: **$has_seq**"
  echo
  echo "## Fork list indexes"
  echo
  printf '%s\n' "$index_status"
  echo
  echo "## Tables"
  echo
  echo '```'
  printf '%s\n' "$tables"
  echo '```'
  echo
  echo "## Migration ledger (\`migration\`)"
  echo
  echo '```'
  printf '%s\n' "$migration_ids"
  echo '```'
  echo
  echo "## Drizzle journal names"
  echo
  echo '```'
  printf '%s\n' "$drizzle_names"
  echo '```'
  echo
  echo "## Policy checklist (manual)"
  echo
  echo "- [ ] Production file not modified by this run"
  echo "- [ ] OPENCODE_DB points at test fixture during app experiments"
  echo "- [x] Permission strategy: keep fork-json-blob; ledger rewrite ids are intentional no-ops"
  echo "- [ ] Ready for MERGE_GATE only if Verdict=PASS and human review"
} > "$REPORT"

echo_kv "report" "$REPORT"
echo_kv "verdict" "$verdict"
echo_kv "integrity" "$integrity"
echo_kv "sessions" "$sessions"
echo_kv "permission_model" "$perm_model"
[[ "$verdict" == "PASS" ]]
