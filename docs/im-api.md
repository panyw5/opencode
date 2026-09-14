# Project IM API

## Delivery scope

This delivery supports ordinary projects sending as the configured bot to its
fixed IM user. Automatic association of a user's reply with the originating
project session, channel takeover, unified channel transcripts, and full project
context continuation are deferred. Existing explicit watch infrastructure is
not an automatic reply-routing or context-sharing mechanism.

Ordinary OpenCode project agents can use already configured IM channels to send
text to the channel's fixed user and watch that user's messages. Projects do not
configure chat IDs, transport credentials, or per-chat read/send grants.

## Using an existing channel

If `cc` already replies to your Feishu private messages, the service discovers
and persists that private recipient from existing records. Historical Feishu
session mappings are checked against the platform's private-chat information.
The verified private-chat owner ID is reused without requiring extra member-list
permissions; member lookup is only a fallback when the provider omits it.
There is no manual conversation ID entry in the normal workflow.

For a new channel with no private-message history, send the bot a private
message once. The channel service records the sender and private chat. A group
message never establishes the fixed private recipient. Once discovered, another
user's message cannot silently replace the recipient.

If several private users exist before discovery, the API reports an ambiguous
recipient rather than choosing the most recent user. Set the channel's existing
allowed-users setting to exactly one user to disambiguate. No project-specific
IM permissions page or target grant is needed.

Use Configuration -> Project IM service to see fixed-recipient readiness and
manage project watches. The selected project is remembered; it does not grant
or deny send access. Disabled channels cannot be used. Discord runtime is not
implemented.

## Agent tools

Ask a normal project agent:

> Use cc to send me: "Deployment complete."

The tool call is simply:

```json
{ "channelName": "cc", "text": "Deployment complete." }
```

Available tools:

- `im_list({})`: configured channel names, platforms, enabled/running state,
  and recipient readiness. Never exposes credentials.
- `im_send({channelName,text,id?})`: send proactively to the channel's fixed
  user. The default idempotency key is stable for the current tool call.
- `im_read({channelName,limit?,cursor?,direction?,waitMs?})`: read only that
  channel's fixed user's private messages. `direction` defaults to `after` in
  the tool; incremental `after` reads can wait up to ten seconds.
- `im_watch({channelName,keyword?})`: watch the fixed user's messages and wake
  the current project session. `keyword` is an optional literal substring.
- `im_watch({action:"list"})`: list watches owned by the current session.
- `im_watch({action:"pause"|"resume"|"stop",subscriptionID})`: manage an owned
  watch. A different session cannot control it. Resume refuses changed recipients.

Tool execution still follows the ordinary configurable OpenCode tool approval
policy. That approval is not an additional per-project target setup step.

Omit `cursor` for the first `im_read`. For later reads, pass the exact opaque
`checkpoint` or `nextCursor` returned by the read API. Subscription `startSeq`
and `deliveryCursor` are internal sequence numbers, not read cursor strings.

For example:

> Watch cc for messages containing "deploy". Read the incoming message, process
> it, and explicitly use im_send through cc to send the result to me.

An ordinary assistant response is not automatically sent to IM. Sending must
be explicit through `im_send`. If several sessions watch the same channel, each
matching session can wake; configure the desired session rather than starting
unnecessary duplicate watches.

## HTTP and SDK

HTTP endpoints use the existing server authentication and workspace routing.
For SDK calls, pass `directory` to select the project; the backend derives its
project identity rather than trusting a payload project ID.

| Endpoint                            | Input                                            | Purpose                    |
| ----------------------------------- | ------------------------------------------------ | -------------------------- |
| `GET /im/channels`                  | workspace routing                                | List configured channels   |
| `POST /im/send`                     | `{channelName,text,id?}`                         | Send to the fixed user     |
| `GET /im/messages`                  | required `channelName`, optional pagination/wait | Read fixed-user messages   |
| `GET /im/subscriptions`             | workspace routing                                | List project watches       |
| `POST /im/subscriptions`            | `{sessionID,channelName,keyword?}`               | Watch in a project session |
| `POST /im/subscriptions/:id/pause`  | workspace routing                                | Pause                      |
| `POST /im/subscriptions/:id/resume` | workspace routing                                | Resume                     |
| `POST /im/subscriptions/:id/stop`   | workspace routing                                | Stop                       |

The obsolete `/im/access` and `/im/targets` endpoints are removed. Historical
database tables and migration histories are retained without activating their
old exact-target permission workflow.

```ts
const directory = "/Users/me/project"
const channels = await client.im.channels({ directory })
const sent = await client.im.send({
  directory,
  channelName: "cc",
  text: "Deployment complete.",
  id: "deployment-2026-09-14-1",
})
const watch = await client.im.subscription.create({
  directory,
  sessionID,
  channelName: "cc",
  keyword: "deploy",
})
```

HTTP requests without `id` create a new send each time. Supply the same ID for
retries of the same notification, and a new ID for a different notification.
Reusing an ID with different content is a conflict. Idempotency is scoped to
the actual project. Failed/unknown attempts are not implicitly retried.

Expected recipient/configuration errors return an explicit invalid-request
message: missing channel, disabled channel, undiscovered recipient, or ambiguous
recipient. Send results distinguish `pending`, `sent`, `failed`, and `unknown`.
`sent` means the provider accepted the message, not that the user read it.

## Recovery and scope

The durable inbox deduplicates provider event IDs, uses monotonic sequence
cursors, and survives process restarts. Watches begin after their creation,
so they do not replay all historical messages. A busy project session receives
deferred input instead of being interrupted. Accepted inputs recover on restart
even if their watch was subsequently stopped; stop blocks future admissions.

Keep OpenCode's channel runtime running for live Gateway reception and project
wakeup. Owner discovery from existing records does not require a new message,
but absence of a registered transport produces a failed send rather than a
successful-looking result. Multiple OpenCode instances using the same provider
bot can affect provider Gateway delivery; do not assume all instances receive
every event.

Text is supported for Feishu private chats and QQ C2C. QQ proactive delivery is
subject to platform eligibility and quotas. Project text longer than the
transport limit is rejected, not silently truncated. Legacy Feishu automatic
card replies retain their separate historical fallback behavior.

Optional channel `retentionDays` (1-3650) removes eligible old IM message bodies;
omitting it disables automatic deletion. Deduplication and send fingerprints
remain, and pending admitted messages/uncertain sends are protected.

This API uses the local OpenCode trust boundary, not operating-system isolation.
Configured ordinary project agents can message the channel's fixed user subject
to their tool approval policy; do not expose the authenticated server or channel
credentials to untrusted remote clients.
