# Durable Session Input Inbox

## 1. Scope / Trigger

This contract applies when an asynchronous background shell or background task produces a terminal result for a parent session.

The result must survive a busy parent runner, provider/tool failure, cancellation, instance disposal, and process restart. A terminal callback must never depend on an in-memory polling fiber to resume the parent.

## 2. Signatures

The Effect service is `SessionInput.Service` from `packages/opencode/src/session/input.ts`:

```ts
interface Interface {
  admit(input: AdmitInput): Effect.Effect<Info>
  pending(sessionID: SessionID): Effect.Effect<Info[]>
  promotedUnacked(sessionID: SessionID): Effect.Effect<Info[]>
  pendingSessions(): Effect.Effect<SessionID[]>
  promote(sessionID: SessionID, limit?: number): Effect.Effect<Info[]>
  ack(inputIDs: readonly SessionInputID[]): Effect.Effect<void>
}
```

The persisted table is `session_input`:

| Column         | Contract                                                                         |
| -------------- | -------------------------------------------------------------------------------- |
| `id`           | Stable source-event dedupe key; primary key                                      |
| `session_id`   | Parent session; cascades on session deletion                                     |
| `prompt`       | JSON `SessionInputPrompt` with `text`, optional `agent`, `model`, and `metadata` |
| `delivery`     | `immediate` or `deferred`; async terminal notifications use `deferred`           |
| `admitted_seq` | Unique, monotonically increasing within a session                                |
| `promoted_seq` | Null while pending; unique, monotonically increasing after claim                 |
| `time_created` | Admission time in Unix milliseconds                                              |

No SQL migration is required when only the TypeScript JSON payload type changes and the physical columns remain unchanged.

## 3. Contracts

### Admission

- Shell `completed`/`error` and task `completed`/`error` call `admit` before requesting a parent drain.
- Shell `stopped` and task `cancelled` do not admit a notification.
- Replaying the same source event uses the same `id`; duplicate admission returns the original row without changing its payload or sequence.
- Terminal payload text and metadata kinds remain compatible:
  - `background-shell-injection`
  - `background-task-injection`

### Promotion and acknowledgment

- `promote` uses an immediate database transaction and atomically claims pending rows in `admitted_seq` order.
- A claimed row remains persisted until its deterministic history message and text part both exist.
- History IDs are derived as `msg_inbox_${inputID}` and `prt_inbox_${inputID}`. Inbox IDs may be `evt_`, `msg_`, job-derived, or another stable string; history IDs must satisfy `MessageID` / `PartID` prefixes.
- `ack` deletes the row only after durable materialization and is idempotent.
- Startup recovery scans both unpromoted and promoted-unacked rows.

### Drain scheduling

- `requestDrain` returns immediately while session status is not idle or an incomplete assistant exists; the database row remains pending.
- No 300 ms polling loop and no 60-second timeout are permitted.
- Every parent `loop` terminal path uses an ensuring finalizer to request a drain.
- A real user prompt materializes pending notifications before writing the real user message, so that the user remains the latest trigger and one loop sees both notifications and user input.
- Concurrent drain requests coalesce per instance/session; database claim remains the cross-caller source of truth.

### Status ordering

`SessionStatus.set` commits the local status map before publishing bus events. A bus publication defect may fail the observer effect, but must not leave the local session status stale.

## 4. Validation & Error Matrix

| Condition                                     | Required behavior                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Empty admission `source`                      | Die with `SessionInput.admit requires a non-empty source`                      |
| `promote` limit is non-integer or less than 1 | Die; do not mutate rows                                                        |
| Duplicate input ID                            | Return original row; do not allocate another sequence                          |
| Parent is busy                                | Log `inbox drain deferred`; retain row unchanged                               |
| Incomplete assistant exists                   | Defer drain; retain row unchanged                                              |
| Crash after promote and before ack            | Recover via `promotedUnacked`; deterministically recreate missing message/part |
| Message exists but part is missing            | Create only the deterministic part, then ack                                   |
| Agent/model omitted in stored prompt          | Resolve from parent session, latest user, or configured defaults               |
| No resolvable parent agent                    | Do not ack; retain row for later recovery                                      |
| Provider loop fails after materialization     | History remains durable; no duplicate materialization                          |
| Status bus publish fails on idle              | Local status still reads `idle`                                                |

## 5. Good / Base / Bad Cases

- **Good:** shell finishes while a foreground subagent runs; row stays pending, then one `msg_inbox_*` message is created when the parent becomes idle and one follow-up loop starts.
- **Base:** shell finishes while parent is idle; admit, promote, materialize, ack, and loop happen immediately through the same scheduler.
- **Bad:** start a temporary `resumeWhenIdle` fiber that polls status and gives up after a timeout. A long foreground run or restart loses the wake-up even though the completion result exists.

## 6. Tests Required

Repository tests in `test/session/input.test.ts` must assert:

- ordered per-session `admitted_seq`;
- duplicate stable IDs preserve the first payload;
- concurrent claimers do not overlap;
- promoted rows replay until acknowledged;
- repeated acknowledgment is harmless.

Integration tests in `test/session/prompt.test.ts` must assert:

- busy provider error leaves the row durable, then materializes one synthetic message and exactly one assistant child for that message;
- two pending notifications plus a real user prompt enter one model loop with the real user latest;
- promoted-unacked recovery creates valid deterministic IDs and does not duplicate on a second pass;
- duplicate terminal admission creates one synthetic message and one loop;
- cancel/interrupt reaches idle and drains pending input.

Status tests in `test/session/status.test.ts` must inject a failing bus and assert that observable local state is already idle.

The real Electron sidecar check must inspect both UI behavior and database state: pending while active, `msg_inbox_*` after release, row removed after ack, one new assistant turn, and no remaining pending row after cancellation.

## 7. Wrong vs Correct

### Wrong

```ts
injectSyntheticMessage()
fork(resumeWhenIdleWithTimeout(parentSessionID))
```

This loses the only wake-up on timeout or restart and can leave the UI at stale `busy`.

### Correct

```ts
yield * inbox.admit({ id: stableEventID, sessionID, prompt, source })
yield * requestDrain(sessionID)

// Parent runner terminal path
yield * runParent(sessionID).pipe(Effect.ensuring(requestDrain(sessionID)))
```

The database preserves ownership and ordering; repeated wake-ups are safe because claim, deterministic materialization, and ack are idempotent.
