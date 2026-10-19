# Remote Access

Remote access lets a paired mobile browser connect to the OpenCode host through an OpenTunnel relay. Enabling it is explicit because remote messages can start code execution on the host. The relay forwards traffic; the host remains the execution environment.

## Pairing and access

Enable remote access in Desktop Settings, then generate a short-lived pairing QR from the online state. The QR contains a one-use pairing link. Treat it as a credential until it expires or is consumed. Approved devices are listed in settings and can be revoked individually; Reset revokes all paired devices. Disabling remote access stops the relay connection.

The mobile browser stores its authenticated session only in the server-issued HttpOnly cookie. The app does not save pairing codes, cookies, or session tokens to local storage. Use a trusted device and revoke it when no longer needed.

## Supported scope

The remote web app supports the core session workflow: browsing projects and sessions, reading conversation history and files exposed by the host, composing and sending messages, and responding to permission prompts. Tool permissions remain governed by the host's OpenCode permission configuration.

Provider credentials and configuration, server administration, desktop browser controls, and terminal UI are not supported in the remote client. The remote gateway must enforce those restrictions server-side as well; hiding a control in the web app is not an authorization boundary.

Remote access uses the configured relay implementation. This documentation makes no availability, pricing, or cloud-hosting promises.

## Phone and tablet layouts

The browser UI uses a single conversation column below 1024 CSS pixels. Projects and sessions open in a slide-out drawer; the header menu shows the complete current title. Conversation and Changes are separate views so the composer does not cover the diff. At 1024 pixels and wider, the review panel can sit next to the conversation.

Below 1440 pixels, and whenever a larger browser's conversation column becomes narrow, the composer keeps attachment, model selection, message options, and send/stop in a compact row. Agent and variant controls and reading mode are in Message options. Notifications live in the header instead of floating over the send button. The browser tracks the visual viewport to fit mobile keyboards and respects device safe-area insets without disabling pinch zoom. Tablet-sized browsers display only one auxiliary panel at a time, keeping the file tree from squeezing the review panel.

For responsive regression checks, build the remote web assets, start the isolated harness with `--hold --responsive`, then run the CDP harness with `--responsive --locale=zh-CN`. It checks widths from 320 to 1440 pixels, a reduced-height keyboard-sized viewport, tablet review split view, message options, model selection, notifications, and the project drawer before sending a real test message. `--web-root <compiled-directory>` lets the isolated harness verify a temporary web build without changing the live remote entry point. CDP emulation is not a substitute for physical iOS Safari and Android testing.

## Lifecycle and credentials

Remote access is off by default. An explicit enable is remembered for the development or installed app profile separately. Closing the app stops its remote process; this is not an independent always-on service. Disabling the entry point does not delete projects, sessions, or paired-device records. Reset removes paired-device access and revokes the stored tunnel identity.

Device tokens expire on the host after 30 days. Pairing links expire after five minutes and are single-use. The local sidecar password is never given to a remote browser. Tunnel keys and device metadata are encrypted using Electron safeStorage; environments without a supported secure backend fail closed instead of saving plaintext. Persistence failures stop remote access, report an error, and require an explicit retry or reset.

## Verification

Permission replies support both the canonical `/permission/:requestID/reply` route and the session-scoped `/session/:sessionID/permissions/:permissionID` route currently used by the permission dock. Both are authenticated writes with the same exact-Origin and CSRF checks; neighboring shell/admin routes stay denied.

Run the isolated harness with `--permission --hold` to exercise a real permission request for a harmless `printf`. It approves once through the session-scoped route and verifies completed tool output plus the persisted assistant reply. The browser invite marks the permission fixture so the CDP harness additionally clicks the actual Allow once control and verifies its POST returns 200 before checking the new tool result and assistant reply. The test never approves a host user's pending permission.

Model catalogs have a separate 32 MiB encoded and decoded JSON budget; regular configuration responses retain a 2 MiB budget. Oversized responses fail before their body is exposed, and gateway errors remove the upstream length and encoding headers. Diagnostic logs contain route names, byte counts, status and reason codes, not credentials, query values, or response bodies.

## Device Activity And Pages

The host settings show pairing time, last activity (to seconds), a short authorization ID, and activity/pairing sort options. Duplicate display names are independent authorizations; sorting does not merge or revoke them.

New remote clients use `POST /remote/api/presence` only when the authenticated session advertises the `presence` capability. The endpoint requires the device cookie, the exact public Origin, and CSRF, and is handled by the gateway rather than forwarded to the sidecar. Each browser tab uses a random in-memory ID and monotonic sequence numbers to prevent out-of-order heartbeats from reviving a closed page. The host accepts at most eight tab leases per authorization.

Clients check page changes every five seconds and send an unchanged heartbeat every twenty seconds. Pagehide closes the tab lease; a missing heartbeat expires after sixty seconds. Foreground browsing, background pages, no active pages, and unknown (legacy or not-yet-reported) status are distinct. Browser-reported page state is informational, not proof that a physical device is connected or a security signal.

Page metadata includes only page kind, project basename, optional session ID, visibility, and server receive time. It never includes full project paths, URL query/fragment values, session titles, or message contents. Page state is memory-only and is cleared on revoke, logout, reset, or gateway shutdown; it is not written to the authorization vault. Existing remote clients need a refresh to start reporting. The settings poll while their remote-access tab is open.

`bun packages/desktop/scripts/remote-models-cdp.ts <project-directory> [second-directory]` checks the current desktop backend through a separate authenticated loopback gateway. It verifies real provider/model counts and visible mobile model options without sending a model request or editing an existing session. This is read-only with respect to the host's user data; the QA browser is temporary.

Run desktop unit tests from `packages/desktop` with `bun test src/main/remote src/main/relaunch.test.ts`. Run the focused web tests from `packages/app` with `bun test --preload ./happydom.ts src/remote`.

From the repository root, `bun packages/desktop/scripts/remote-access-e2e.ts` runs a real isolated sidecar and a deterministic local model provider through the gateway. It uses temporary data, never existing sessions or paid model credentials. Add `--tunnel` to exercise the actual public HTTPS relay; the QA tunnel uses a separate Node process matching the production runtime rather than the Bun test runner. The harness requires a recent Node release supporting `--use-system-ca` and `--use-env-proxy` (verified with Node 25).

Add `--hold` to retain the fixture for browser checks. Its output identifies a temporary artifacts directory containing a private `browser-invite.json`; pairing links and tokens are not printed. With the development Electron app already listening on CDP 9222, run `bun packages/desktop/scripts/remote-access-cdp.ts <artifacts>/browser-invite.json`. This checks the mobile home, history, actual composer submission, and persisted reply. Stop the held fixture with SIGINT or SIGTERM afterwards; it closes the gateway, sidecar, and bridge and revokes the QA tunnel identity.

`bun packages/desktop/scripts/remote-settings-cdp.ts` checks settings and consent cancellation without opening public access. Its separate `--live` option operates on the current development app and must only be used with explicit authorization to expose that app's existing data temporarily. It disables access again on completion or error.

Hidden Electron views can stop producing compositor frames even while their DOM and network are active. Screenshot capture times out rather than hanging indefinitely; `--no-screenshots` disables animations in the QA page and explicitly dispatches resize/media events using the browser's actual viewport values. It runs responsive bounds, navigation, and real message checks without compositor capture. It does not claim native rendering-event, visual screenshot, or animation verification.
