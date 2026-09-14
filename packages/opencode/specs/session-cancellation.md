# Session cancellation control

## Ownership

The instance owns one session controller for its lifetime. Controllers are
not removed on idle: their cancellation revision must survive between runs.
The instance scope disposes all controllers and their tasks.

Runner owns atomic task admission and stopping. SessionRunState supplies
background-job cleanup; SessionPrompt supplies message finalization. Runner
does not know about the database, inbox, models, or background jobs.

## Stop transaction

1. Atomically increment the cancellation revision and enter Stopping.
2. Interrupt the old task and wait for its finalizers.
3. Stop its session background jobs.
4. Finalize incomplete assistant messages.
5. Publish idle and release Stopping waiters.

Admission during Stopping waits without holding the state lock. Preparation
captures the revision before any asynchronous work; admission rejects stale
revisions, including retries after a coalesced run. Repeated stop requests
during the same stop share its completion. Stop completion is uninterruptible
so a disconnected HTTP caller cannot leave a controller stranded.

Graceful restart also waits for the previous task's finalizers before admitting
replacement work. Existing callers remain attached to the replacement result.
A user stop during restart invalidates that replacement's revision.

The renderer waits for an in-flight send acknowledgement before posting stop.
This orders the two HTTP requests without adding arbitrary sleeps. Backend
revision checks cover preparation after acknowledgement but before admission.
The renderer's optimistic idle display is not authoritative backend state.
Renderer stop operations also coalesce, and subsequent sends wait for the
stop acknowledgement. A stopped intervention does not schedule a late flush.

## Initialization lifetime

Instance and model catalog caches retain successful initialization indefinitely.
Failure and interruption results expire immediately, allowing the next caller
to close the failed entry's scope and initialize again. No session-specific
cache invalidation is performed during stop: session tasks and shared service
state have different ownership.

Model lookup preserves interrupt-only causes. Turning cancellation into a
defect bypasses Runner's cancellation handling and must not be done.

## Regression coverage

- Cancel during initialization, then retry without reloading the instance.
- Cancel before task admission: stale preparation must not start work.
- New admission during stop waits for both task and business cleanup.
- Repeated stop requests do not start a second cleanup transaction.
- Graceful restart keeps coalesced callers and does not overlap old finalizers.
- Existing shell, child-task, inbox-drain, and location-lease cancellation tests.

Electron QA uses only the development renderer on CDP 9222 and a dedicated
test session. It verifies rapid stop, repeated stop, subsequent replies, and
backend logs; installed-app sessions are not modified.

## Verified on 2026-09-14

- Electron normal stop followed by CANCEL_RETRY_OK.
- Electron stop 39 ms after send followed by FAST_CANCEL_RECOVERED.
- Electron double stop 43 ms after send, with a 250 ms delayed send
  acknowledgement: exactly one abort; send acknowledgement precedes abort,
  abort completion precedes next send; ULTRA_FAST_RECOVERED received.
- Backend logs show revision 0 stop, task finalization, background cleanup,
  message finalization, then revision 1 admission and a normally completed reply.
- Instance and catalog cache tests deterministically cancel the first
  initialization and verify that the second initialization succeeds.

The Electron scenarios exercised real requests and replies but did not
reproduce the historical initialization race itself. The original log and
the deterministic cache reproduction match its interrupt-only failure.
