# Session DB Migration Upgrade (Trellis task)

> **Isolation first.** Production `opencode.db` must not be written until `MERGE_GATE.md` is closed.

## Locations

| What | Path |
|---|---|
| Git worktree | `../trellis-worktrees/session-db-migration-upgrade` |
| Branch | `trellis/session-db-migration-upgrade` |
| Trellis task | `.trellis/tasks/07-30-session-db-migration-upgrade/` |
| Test DB fixture | `.trellis/tasks/07-30-session-db-migration-upgrade/fixtures/opencode-migration-test.db` |
| Quality reports | `.trellis/tasks/.../reports/quality-*.md` |
| Mergeable scripts | `packages/opencode/script/session-db-migration/` |

## Force test DB

```bash
export OPENCODE_DB="/absolute/path/to/.../fixtures/opencode-migration-test.db"
# or:
./.trellis/tasks/07-30-session-db-migration-upgrade/scripts/open-with-test-db.sh bun run dev
```

## Workflow

1. `scripts/snapshot-test-db.sh` — refresh test copy from production (read-only source)
2. `scripts/assess-db-quality.sh --label baseline`
3. Implement migration/schema upgrades **only against test DB**
4. `apply-test-db.sh` — open fixture via `Database.Client` (drizzle + upstream + repairs)
5. `scripts/assess-db-quality.sh --label after`
6. Close `MERGE_GATE.md` (requires human G10)
7. Merge branch → main worktree `dev`
8. **Human confirm** → backup production → upgrade production

## Phase 2 invariants (upstream-migration)

- Never `DELETE` core rows (`session` / `message` / `part` / `event` / `session_message`) in the bridge
- `reset_v2_session_state` is a documented no-op on this fork
- After every apply: dual-ledger sync + ensure fork list indexes / project_directory / credential

## Safety

- Scripts refuse to target production unless `--allow-production` (assess only)
- Fixture DBs are gitignored
- Destructive upstream resets stay no-op (see task `plan.md`)

## Permission policy (fork)

- **Keep** `permission` as project-scoped JSON blob (`project_id` PK + `data` Ruleset).
- Upstream ledger ids `20260601202201_amazing_prowler` and `20260602002951_lowly_union_jack` complete as **intentional no-ops** (do not rewrite to row-level).
- On open, `repairPermissionSchema` converts accidental upstream row-level shape back to fork blob.
- Assess treats “ledger complete + still fork-json-blob” as **ok**, not WARN.

## Schema alignment (Phase 1)

Managed drizzle schema now includes tables that already exist on live DBs:

- `project_directory` (`ProjectDirectoryTable`)
- `credential` (`CredentialTable`)

Physical ensure for new DBs: `packages/opencode/src/storage/upstream-migration.ts`.
