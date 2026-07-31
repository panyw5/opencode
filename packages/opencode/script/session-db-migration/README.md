# Session DB migration isolation scripts

Safe helpers for the Trellis task **session-db-migration-upgrade**.

## Rules

1. Never write production `~/.local/share/opencode/opencode.db` during experiments.
2. Use an absolute `OPENCODE_DB` pointing at the test fixture.
3. Run quality gates before merge (`MERGE_GATE.md` in the Trellis task).

## Commands

```bash
# From repo root (worktree)
export OPENCODE_MIGRATION_TASK_DIR="$PWD/.trellis/tasks/07-30-session-db-migration-upgrade"

./packages/opencode/script/session-db-migration/snapshot-test-db.sh
./packages/opencode/script/session-db-migration/assess-db-quality.sh --label baseline

# App against test DB only
./packages/opencode/script/session-db-migration/open-with-test-db.sh bun run --cwd packages/opencode src/index.ts
```

Apply migration pipeline on the test fixture only:

```bash
./packages/opencode/script/session-db-migration/apply-test-db.sh
```

After upgrades:

```bash
./packages/opencode/script/session-db-migration/assess-db-quality.sh --label after
```
