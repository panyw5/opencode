# WeChat ClawBot Channel

## Scope

Native Tencent iLink integration; no OpenClaw installation is required.
Supports private text, images, safe files, MP4 video, available voice transcripts,
automatic replies, durable IM reads, and project subscription wakeup. Encrypted
inbound media is downloaded, decrypted, persisted, and supplied to the model.
Group chats and outbound media tools are deferred. Project markdown remains
Feishu-only.

## Connect

1. Open Configuration -> Message channels -> WeChat.
2. Create a named channel and expand its row.
3. Select QR authorization, scan with phone WeChat, and confirm authorization.
4. If requested, enter the verification code and explicitly submit it.
5. Check connection status and send a private message to establish reply context.

Refresh an expired QR attempt. Cancelling or navigating away invalidates it.
An "already bound" response without new usable credentials is not a successful
new authorization. Normal long-poll timeouts remain retryable until QR expiry.

Empty allowed-users permits only the QR-authorized user. Explicit IDs restrict
senders; '\*' explicitly permits any delivered sender. The fixed recipient is
normally the scanner. Rebinding retains the channel settings and allowlist;
check them when changing the authorized user.

## Project IM

Use im_list, im_read, im_send, and im_watch as for other channels:

```json
{ "channelName": "wechat", "text": "Deployment complete." }
```

Subscriptions take precedence over automatic channel replies. A project agent
response alone does not send to WeChat; use im_send explicitly. Messages received
with autoReply disabled are stored but not answered retroactively when enabled.

Proactive private delivery is limited: sending requires a private context token
from that recipient's inbound message. The server does not guarantee indefinite
token validity or unlimited notifications. With no context, sending fails before
a provider request. Unknown send outcomes are not automatically retried. Provider
acceptance is not proof of user receipt or reading.

Project sends derive their provider client ID from the durable project/send
identity; automatic replies use the durable inbound record ID. This keeps
attempt identifiers stable, but is not a promise of provider-side deduplication.
Unknown outcomes are still not retried automatically.

## Security And Recovery

Credentials and reply context are outside channels.json under the local private
state root. Public configuration contains only account IDs, API origin, and
ordinary settings. Directories use 0700 and private files 0600 where POSIX
permissions are supported. Do not attach private state to support reports.

Inbound media uses trusted Tencent CDN hosts only, rejects redirects and active
image formats, and enforces 20 MiB per item, 40 MiB per message, and ten items.
Encrypted bytes and keys never enter public metadata. Temporary IM copies are
SQLite BLOBs deleted with their message; materialized sessions own their copy.
Unavailable/rejected items are exposed only as safe descriptors so a poison
event cannot permanently block the receive cursor. Server-ID-only quote-cache
restoration is not included; ordinary text and captions remain available.

Messages/context are persisted before advancing the receive cursor. AI replies
are queued separately. Received/unclaimed events recover after restart;
processing/unknown replies are conservatively not resent automatically because
their prior delivery may be uncertain.

One account/origin can have one local monitor within a shared state root.
Live-process locks are not stolen; abandoned locks can recover. Different state
roots/machines are not covered by the local lock, and provider multipoller
delivery semantics are not guaranteed. Only the lock owner sends lifecycle
notifications.

Connection states: awaiting_login, connected, reconnecting, auth_expired,
account_busy, stopped. Provider -14 aborts polling/sends until reauthorization.
Reauthorizing the same account refreshes its runtime even if public IDs are
unchanged. A failed startup retains credentials for a later retry.

## HTTP / SDK

The endpoints use existing authenticated server/workspace routing:

| Method | Path                    | Payload/query                               |
| ------ | ----------------------- | ------------------------------------------- |
| POST   | /im/wechat/login/start  | channelName                                 |
| POST   | /im/wechat/login/poll   | channelName, attemptID, optional verifyCode |
| POST   | /im/wechat/login/cancel | channelName, attemptID                      |
| GET    | /im/wechat/status       | channelName                                 |

SDK: im.wechat.login.start/poll/cancel and im.wechat.status. Confirmed polling
binds public account identity and updates configuration. Tokens never appear in
these responses. Status is not a send/receipt test. Login cannot replace a
different platform's channel name. Provider hosts/redirects must be trusted
HTTPS WeChat origins without credentials, ports, non-root paths, query, or hash.

## Verification

The implementation checklist and recorded results are in wechat-channel-todo.md.
Mock provider/LLM end-to-end tests are separate from real phone authorization
and message delivery. Real QR retrieval was verified in development Electron;
real private delivery is pending phone authorization at this writing.

Primary reference: Tencent/openclaw-weixin commit
7c04adc3e95775efd661ab9fba0626d86d237713, docs/protocol.md and client sources.
