# Channel-Only IM Rework Verification

Date: 2026-09-14, Asia/Shanghai.

## Removed and Retained

Removed the wrong product flow: manual conversation-ID form, per-project
read/send/watch switches, public Access/Targets management endpoints, runtime
ACL service, and ACL checks/joins in read/send/subscription/retention.

Reworked tools and HTTP/SDK around configured channels and automatic fixed
private-recipient discovery. Kept internal provider targets, channel runtimes,
durable inbox/sequence/dedupe, project-scoped send idempotency, uncertain-send
handling, QQ sequences, durable session admission and restart recovery.

Historical access schema/migration files remain for compatibility with databases
already migrated. They do not authorize or block current project operations.
The earlier exact-target validation report is historical, not acceptance of
this corrected product contract.

## Normal-Environment Acceptance

The coordinator personally tested the development Electron Node utility-process
sidecar, not a standalone send adapter or mocked Gateway/model. It used the
existing `~/.config/opencode` configuration, configured real channels, shared
`~/.local/share/opencode/opencode.db`, and real GPT-5.6-luna.

- Project: `/Users/lelouch/chat`.
- Session: `ses_ffe5f5fdbee4cffezEIL3SbDA9`.
- Marker: `IM_CHANNEL_E2E_1789393113519`.

1. `GET /im/channels` automatically discovered existing cc, harold-qq and Root
   recipients and returned ready/running metadata. No project grant or manual
   target input was used. For Feishu cc, real private-chat metadata confirmed
   `chat_mode=p2p`; its owner open ID matched the previously verified private
   inbound sender. This did not require member-list permissions.
2. The ordinary project agent called `im_list`, then `im_send` with only
   channelName, text and an optional send key. It supplied no conversation ID,
   platform, target or mode. The result was sent with one attempt.
3. The agent called `im_watch` with cc and the unique marker, then ended READY.
4. The coordinator used the real logged-in Feishu desktop client to send
   `IM_CHANNEL_E2E_1789393113519 PING` with a harmless test-only suffix.
5. Real Gateway event `om_x100b654bde1e9ca4b288924cfe10066` was persisted by the
   native development sidecar, admitted into the owning project session, and
   automatically woke the agent. No test injection or follow-up prompt was used.
6. The agent called channel-only `im_read` and `im_send`, sending WATCH VERIFIED.
7. A separate real HTTP `POST /im/send` with exactly channelName and text (no
   send ID) generated an idempotency key and sent HTTP VERIFIED with one attempt.
8. Provider message queries confirmed all three exact bodies below. The Feishu
   desktop client visibly displayed SEND VERIFIED and WATCH VERIFIED. Each
   outbound row was sent with exactly one provider attempt; the test session
   had zero pending inputs.

```text
IM_CHANNEL_E2E_1789393113519 SEND VERIFIED
IM_CHANNEL_E2E_1789393113519 WATCH VERIFIED
IM_CHANNEL_E2E_1789393113519 HTTP VERIFIED
```

The first im_read call invented cursor `-1`; the service correctly rejected
it, and a subsequent read without that cursor succeeded. The tool/documentation
now explicitly says to omit the first cursor and use only returned opaque
checkpoints, never internal subscription sequence numbers.

## UI Persistence

The coordinator selected `/Users/lelouch/chat` in Project IM service, left for
Providers, returned, refreshed the renderer, and reopened the service page.
The selected project remained chat. Electron IPC storage confirmed:

```text
file: opencode.global.dat
key: config.im.service.v1
value: {"selectedDirectory":"/Users/lelouch/chat"}
```

The page showed the configured fixed recipients and subscription controls,
without chat-ID inputs or read/send/watch permission switches.
The final development process restart also preserved chat selection and all
three configured ready/running fixed recipients; 16 providers remained connected.

## Final Safety Regressions

The final audit found active historical subscriptions could outlive their
recipient. New admissions now resolve the current channel owner and require an
exact private-recipient and sender snapshot. Automated integration tests verify
old group/A snapshots do not admit after switching to B, while an A input
accepted before the switch still recovers exactly one assistant turn. HTTP
subscription list/control also rejects other directories, even for a shared
project ID.

Final verification: 108 backend tests passed, zero failures, 429 assertions;
five frontend tests passed; backend/app/SDK typechecks and diff checks passed.

## Evidence and Limits

- Normal test session and message/tool records remain in the shared database.
- `/private/tmp/im-rework-provider-verification.log`: three real provider checks.
- `/private/tmp/im-rework-ui.png`: actual development renderer screenshot.
- `/private/tmp/im-rework-electron.log`: development startup/output.
- `/private/tmp/im-rework-electron-delivery.log`: latest normal process restart.
- `/private/tmp/im-rework-backend-delivery.log`: final joint regression results.
- Final test/typecheck counts are recorded in the active rework TODO.

The test watch was stopped and the coordinator-created session archived
(recoverable); no original user session, channel credentials/configuration or
installed application was deleted, stopped, or reconfigured. The persisted
fixed-recipient records are intentional normal application data. No isolated
database/configuration or simulated model was left active.

Another existing consumer of cc also issued a legacy reply; it is not counted
as project-tool output. This verifies one real Feishu private-chat path, not
cross-instance exactly-once delivery, all QQ scopes, or real QQ inbound
end-to-end. QQ owner discovery and receiver paths have separate automated tests.
