import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "db.upstream-migration" })

type RawSQLiteStatement = {
  all: (...params: unknown[]) => unknown[]
}

type RawSQLiteClient = {
  query?: unknown
  prepare?: unknown
}

type MigrationClient = {
  run: (sql: string, ...params: unknown[]) => unknown
  $client: RawSQLiteClient
}

type Migration = {
  id: string
  up: (db: MigrationClient) => void
}

function rawAll(db: MigrationClient, sql: string) {
  const client = db.$client
  if (typeof client.query === "function")
    return (client.query(sql) as RawSQLiteStatement).all() as Record<string, unknown>[]
  if (typeof client.prepare === "function")
    return (client.prepare(sql) as RawSQLiteStatement).all() as Record<string, unknown>[]
  throw new Error("SQLite client does not support raw all queries")
}

function hasTable(db: MigrationClient, table: string) {
  return (
    rawAll(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${JSON.stringify(table)} LIMIT 1`)
      .length > 0
  )
}

function columns(db: MigrationClient, table: string) {
  return rawAll(db, `PRAGMA table_info(${JSON.stringify(table)})`).map((column) => String(column.name))
}

function hasColumn(db: MigrationClient, table: string, column: string) {
  return columns(db, table).includes(column)
}

function createSessionMessageSeqIndexes(db: MigrationClient) {
  db.run("DROP INDEX IF EXISTS session_message_session_idx")
  db.run("DROP INDEX IF EXISTS session_message_session_type_idx")
  db.run("DROP INDEX IF EXISTS session_message_session_type_time_created_id_idx")
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS session_message_session_seq_idx ON session_message (session_id, seq)")
  db.run("CREATE INDEX IF NOT EXISTS session_message_session_type_seq_idx ON session_message (session_id, type, seq)")
  db.run(
    "CREATE INDEX IF NOT EXISTS session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)",
  )
  db.run("CREATE INDEX IF NOT EXISTS session_message_time_created_idx ON session_message (time_created)")
}

function ensureFinalSessionInput(db: MigrationClient) {
  if (!hasTable(db, "session_input")) {
    db.run(`
      CREATE TABLE session_input (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        prompt text NOT NULL,
        delivery text NOT NULL,
        admitted_seq integer NOT NULL,
        promoted_seq integer,
        time_created integer NOT NULL,
        CONSTRAINT fk_session_input_session_id_session_id_fk
          FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      )
    `)
  } else if (!hasColumn(db, "session_input", "admitted_seq")) {
    db.run("PRAGMA foreign_keys = OFF")
    db.run("DROP INDEX IF EXISTS session_input_session_pending_seq_idx")
    db.run("DROP INDEX IF EXISTS session_input_session_pending_delivery_seq_idx")
    db.run(`
      CREATE TABLE __new_session_input (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        prompt text NOT NULL,
        delivery text NOT NULL,
        admitted_seq integer NOT NULL,
        promoted_seq integer,
        time_created integer NOT NULL,
        CONSTRAINT fk_session_input_session_id_session_id_fk
          FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      )
    `)
    db.run(`
      INSERT INTO __new_session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      SELECT id, session_id, prompt, delivery, seq, promoted_seq, time_created
      FROM session_input
    `)
    db.run("DROP TABLE session_input")
    db.run("ALTER TABLE __new_session_input RENAME TO session_input")
    db.run("PRAGMA foreign_keys = ON")
  }

  db.run(
    "CREATE INDEX IF NOT EXISTS session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, admitted_seq)",
  )
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS session_input_session_admitted_seq_idx ON session_input (session_id, admitted_seq)",
  )
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS session_input_session_promoted_seq_idx ON session_input (session_id, promoted_seq)",
  )
}

function ensureFinalSessionContextEpoch(db: MigrationClient) {
  if (!hasTable(db, "session_context_epoch")) {
    db.run(`
      CREATE TABLE session_context_epoch (
        session_id text PRIMARY KEY,
        baseline text NOT NULL,
        snapshot text NOT NULL,
        baseline_seq integer NOT NULL,
        CONSTRAINT fk_session_context_epoch_session_id_session_id_fk
          FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      )
    `)
    return
  }

  const existing = columns(db, "session_context_epoch")
  const final = ["session_id", "baseline", "snapshot", "baseline_seq"]
  if (existing.length === final.length && final.every((column) => existing.includes(column))) return

  db.run("PRAGMA foreign_keys = OFF")
  db.run(`
    CREATE TABLE __new_session_context_epoch (
      session_id text PRIMARY KEY,
      baseline text NOT NULL,
      snapshot text NOT NULL,
      baseline_seq integer NOT NULL,
      CONSTRAINT fk_session_context_epoch_session_id_session_id_fk
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    )
  `)
  db.run(`
    INSERT INTO __new_session_context_epoch (session_id, baseline, snapshot, baseline_seq)
    SELECT session_id, baseline, snapshot, baseline_seq
    FROM session_context_epoch
  `)
  db.run("DROP TABLE session_context_epoch")
  db.run("ALTER TABLE __new_session_context_epoch RENAME TO session_context_epoch")
  db.run("PRAGMA foreign_keys = ON")
}

const migrations: Migration[] = [
  {
    id: "20260511173437_session-metadata",
    up(db) {
      if (!hasColumn(db, "session", "metadata")) db.run("ALTER TABLE session ADD metadata text")
    },
  },
  {
    id: "20260601010001_normalize_storage_paths",
    up(db) {
      if (hasTable(db, "project") && hasColumn(db, "project", "worktree")) {
        db.run(
          "UPDATE project SET worktree = REPLACE(worktree, char(92), '/') WHERE worktree GLOB '[A-Za-z]:' || char(92) || '*' OR worktree LIKE char(92) || char(92) || '%'",
        )
      }
      if (hasTable(db, "project") && hasColumn(db, "project", "sandboxes")) {
        db.run(
          "UPDATE project SET sandboxes = REPLACE(sandboxes, char(92) || char(92), '/') WHERE instr(sandboxes, char(92)) > 0 AND (worktree GLOB '[A-Za-z]:*' OR worktree LIKE '//%')",
        )
      }
      if (hasTable(db, "session") && hasColumn(db, "session", "directory")) {
        db.run(
          "UPDATE session SET directory = REPLACE(directory, char(92), '/') WHERE directory GLOB '[A-Za-z]:' || char(92) || '*' OR directory LIKE char(92) || char(92) || '%'",
        )
      }
      if (hasTable(db, "session") && hasColumn(db, "session", "path")) {
        db.run(
          "UPDATE session SET path = REPLACE(path, char(92), '/') WHERE path IS NOT NULL AND instr(path, char(92)) > 0 AND (directory GLOB '[A-Za-z]:*' OR directory LIKE '//%')",
        )
      }
    },
  },
  {
    id: "20260603001617_session_message_projection_indexes",
    up(db) {
      if (hasTable(db, "event")) {
        db.run("CREATE INDEX IF NOT EXISTS event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)")
      }
      if (hasTable(db, "session_message") && hasColumn(db, "session_message", "seq")) createSessionMessageSeqIndexes(db)
    },
  },
  {
    id: "20260603040000_session_message_projection_order",
    up(db) {
      if (hasTable(db, "session_message") && hasColumn(db, "session_message", "seq")) createSessionMessageSeqIndexes(db)
    },
  },
  {
    id: "20260603141458_session_input_inbox",
    up(db) {
      ensureFinalSessionInput(db)
    },
  },
  {
    id: "20260603160727_jittery_ezekiel_stane",
    up(db) {
      ensureFinalSessionInput(db)
      if (hasTable(db, "event")) {
        db.run("CREATE INDEX IF NOT EXISTS event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)")
      }
      if (hasTable(db, "session_message") && hasColumn(db, "session_message", "seq")) createSessionMessageSeqIndexes(db)
    },
  },
  {
    id: "20260604172448_event_sourced_session_input",
    up(db) {
      ensureFinalSessionInput(db)
      if (hasTable(db, "session_message") && hasColumn(db, "session_message", "seq")) createSessionMessageSeqIndexes(db)
    },
  },
  {
    id: "20260605003541_add_session_context_snapshot",
    up(db) {
      ensureFinalSessionContextEpoch(db)
    },
  },
  {
    id: "20260622142730_simplify_session_context_epoch",
    up(db) {
      ensureFinalSessionContextEpoch(db)
    },
  },
  {
    id: "20260622170816_reset_v2_session_state",
    up() {
      // Upstream clears derived v2 state here. This fork still treats these rows
      // as potentially valuable, so production migration marks the id complete
      // without deleting canonical or projection data.
    },
  },
  {
    id: "20260622202450_simplify_session_input",
    up(db) {
      ensureFinalSessionInput(db)
      ensureFinalSessionContextEpoch(db)
    },
  },
]

function seedFromDrizzleJournal(db: MigrationClient) {
  if (!hasTable(db, "__drizzle_migrations")) return
  db.run(`
    INSERT OR IGNORE INTO migration (id, time_completed)
    SELECT name, ${Date.now()}
    FROM __drizzle_migrations
    WHERE name IS NOT NULL
  `)
}

function completed(db: MigrationClient) {
  return new Set(rawAll(db, "SELECT id FROM migration").map((row) => String(row.id)))
}

function runMigration(db: MigrationClient, migration: Migration) {
  db.run("BEGIN IMMEDIATE")
  try {
    migration.up(db)
    db.run(
      `INSERT OR IGNORE INTO migration (id, time_completed) VALUES (${JSON.stringify(migration.id)}, ${Date.now()})`,
    )
    db.run("COMMIT")
  } catch (err) {
    try {
      db.run("ROLLBACK")
    } catch {
      // Preserve the migration failure.
    }
    throw err
  }
}

export function apply(db: MigrationClient, dbPath: string) {
  if (!hasTable(db, "session")) return

  db.run("CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
  let done = completed(db)
  if (done.size === 0) {
    seedFromDrizzleJournal(db)
    done = completed(db)
  }

  const pending = migrations.filter((migration) => !done.has(migration.id))
  if (pending.length === 0) return

  log.info("applying upstream migrations", {
    path: dbPath,
    count: pending.length,
    migrations: pending.map((migration) => migration.id),
  })
  for (const migration of pending) runMigration(db, migration)
}
