# Live IM End-to-End Verification

> Historical verification of the rejected exact-target API. Current channel-only
> product acceptance: [im-channel-rework-verification.md](im-channel-rework-verification.md).

Date: 2026-09-14 (Asia/Shanghai).
Result: PASS for Feishu private chat.

## Environment

- Backend: repository source server on localhost:43127, with its normal
  configuration loading and ChannelManager startup (not a standalone send
  adapter).
- Temporary configuration: one real `cc` Feishu channel copied from the
  existing channel configuration, enabled with `autoReply: false`.
- Agent: real `axonhub-codex/gpt-5.6-luna`, not a simulated model.
- Project: `/private/tmp/opencode-im-live-e2e-v2/project`.
- Session: `ses_ffe5f60017a52ffeXhUxQb1lX3`.
- Marker: `IM_LIVE_E2E_1789390651325`.
- Project authorization: read, send, and watch for exactly the test private
  conversation. The agent could use only IM tools; all other tool permissions
  were denied.

## Verified Path

1. The real agent called `im_watch` and created an active keyword-filtered
   subscription, then finished its setup turn with `READY`.
2. The coordinator sent the marker from the logged-in Feishu desktop client.
3. The real Feishu WebSocket Gateway delivered the message to the configured
   backend receiver. No mocked event or database injection was used.
4. The receiver persisted inbound event `om_x100b654ab976b8b0b3f061ec010c6b1`.
5. The dispatcher admitted the message to the owning project session and
   automatically resumed the agent without another user prompt.
6. The agent called `im_read`, found the matching event, and called `im_send`
   in reply mode with its platform `eventID`.
7. The tool returned `sent`, attempt count 1, and provider message ID
   `om_x100b654ab6e0ccb4c12a01fdb555405`.
8. A real provider message query confirmed the exact expected reply body.
9. The coordinator observed the same reply in the Feishu desktop client:

```text
IM_LIVE_E2E_1789390651325 VERIFIED: real Feishu inbound -> project agent -> im_send
```

The agent finished with `VERIFIED`. Read-only database inspection found zero
pending session inputs and exactly one sent outbound row with one attempt.

## Failures and Limitations

The first run failed because the coordinator's setup instruction incorrectly
specified an internal message ID for `replyTo`. The service rejected it before
sending. The second run used the documented platform `eventID`; the tool's
parameter description was also clarified. Focused service and tool regression
tests passed: 11 tests, 56 assertions.

The existing channel had another consumer that remained running. The first
message in the second run was not observed by the test backend and produced an
existing legacy reply. A bounded second marker message entered the test
backend and completed the verified path above. That unrelated legacy reply is
not counted as successful project-tool output. The installed application was
not stopped or reconfigured. Shared-channel multi-instance routing was not
proven reliable by this test.

This run used the repository backend source process, not the Electron Node
utility-process sidecar. The earlier native sidecar restart test remains a
separate verification. This result does not claim QQ real inbound end-to-end,
group-chat, media, or all-provider coverage.

## Evidence and Cleanup

Local evidence:

- `/private/tmp/opencode-im-live-e2e-v2/evidence.json`: received event, session
  tools, real model ID, and provider verification result.
- `/private/tmp/opencode-im-qa/live-e2e-v2.log`: backend startup, Gateway
  receiver, agent execution, and cleanup logs.
- `/private/tmp/opencode-im-live-e2e-v2/im.sqlite`: isolated test database.

After completion, test subscriptions were stopped, exact-target authorization
was revoked, the test Gateway and listeners were stopped, and temporary
channel/model configuration files containing credentials were removed. Original
user configuration and the installed application were left unchanged.
