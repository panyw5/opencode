# Session viewport coordination

## Invariants

- One intent owns positioning: reading, message, find, or live tail.
- Settled message/find targets keep ownership across later measurements until explicit takeover.
- Intent tokens are scoped to the full session key and generation. Layout and request tokens are separate.
- Valid shared history responses may merge after takeover; their callbacks cannot restore obsolete positions.
- Internal hash acknowledgement is not a request to resume the tail.
- User scrolling remains available while history is loading.
- Compensation and velocity use actual applied motion, including browser clamping.
- JavaScript-driven wheel motion is user motion; navigation and layout correction are not.
- Nested scrolling takes over the outer viewport only when input propagates to its boundary.
- Closing find preserves the current position and cannot revive an earlier target.
- Historical prepend remains additive, including overlapping pages and concurrent SSE events.

## Implementation stages

1. Preserve navigation, history merge, measurement, and reachable-target baselines.
2. Extend the existing message intent machine with reading/find takeover and shared-load-safe tokens.
3. Introduce actual-motion accounting and user-only velocity sampling.
4. Route find positioning and outer user input through the intent machine.
5. Preserve reading motion across historical prepend and recognize outward input at the top edge.
6. Route tail/initial/dock motion through accounting and apply the current intent after layout changes.
7. Exercise composed interactions in development Electron, verify sidecar message delivery, and remove replaced guards.

## Acceptance matrix

| Scenario                                     | Expected result                                             |
| -------------------------------------------- | ----------------------------------------------------------- |
| Loaded/unloaded barcode click                | Same stable-ID navigation path and reachable top goal       |
| Rapid barcode clicks during a fetch          | Latest target wins; shared fetch is not duplicated          |
| Barcode, then find, then late height         | Find remains visible; old barcode cannot reposition         |
| Find, then barcode                           | Old find cannot recenter                                    |
| Query replacement, no results, close         | Old query callbacks cannot scroll                           |
| User input at either physical edge           | Old positioning ownership releases without requiring motion |
| Scroll while a history request waits         | Only layout growth is compensated; user motion survives     |
| Navigate to loaded top, then outward input   | History can load without a down/up detour                   |
| Repeated events from one edge attempt        | No duplicate or compensation-triggered chain load           |
| Large jump followed by small user motion     | Velocity excludes the jump                                  |
| Stream, then user leaves tail                | Later output cannot retake ownership                        |
| Panel resize, expand/collapse, late markdown | Current intent governs residual compensation                |
| Session switch before old request completes  | New session state and viewport remain untouched             |

## Diagnostics

Trace intent request/takeover, hash acknowledgement, request lifecycle, ignored stale callbacks,
layout restore, and actual scroll writes. Include session key/generation, target identity, source,
user displacement, and applied correction. Keep bounded debug output and avoid layout reads per row.

Development verification uses Electron CDP on port 9222 after checking an existing target.
Read effective persisted keybinds before sending shortcuts. Never stop the installed desktop app.
Use a dedicated test session for sidecar send/receive checks, not the original historical session.

## Verification on 2026-09-12

- Focused navigation, history, geometry, ledger, and additive-merge suites: 99 passed.
- Browser-condition find/virtualizer suites: 16 passed.
- ScrollView and auto-scroll suites: 9 passed.
- App and UI type checks and diff whitespace checks passed.
- CDP delayed barcode loading, rapid target replacement, and old-fetch session switching passed.
- CDP barcode/find/barcode/close retained the new barcode with a -0.1875 px offset.
- CDP outward top input requested history without a down/up detour. During a held request,
  continued scrolling retained the same visible row with -0.8046875 px drift after commit.
- CDP post-navigation geometry checks had no settled row-height mismatches.
- A 540 px viewport and emulated touch released navigation and moved the reading viewport
  by 205 px. Desktop metrics were restored afterward; this was not a physical mobile-device test.
- Dedicated sidecar sessions received the exact short reply and real long streaming replies.
  After user detachment, the viewport changed by 1 px while the remaining output arrived.
- Streaming QA exposed an existing missing translation key on the tail action. Using the
  existing `jumpToLatest` key restored its caption and positive dimensions. A native mouse
  click returned to a 0 px tail gap after a full renderer reload.

The broader session suite has one existing failure in `session-render-state.test.ts`:
the no-content deadline case expects object identity, while the unchanged reducer returns
an equivalent new object. Neither that reducer nor its test was modified by this work.

Verification used local execution only, with no remote actions. Concurrent review-panel and file-identity edits
were preserved. The dedicated sidecar QA conversation was kept for diagnostics.
