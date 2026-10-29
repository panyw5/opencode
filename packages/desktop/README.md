# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## System Notifications

Permission requests and assistant questions can notify even when the window is
focused. Ordinary completion notifications are suppressed in the foreground.
The notification switches in Settings still apply; automatically approved
permissions do not notify.

Settings > General > System notifications provides a test notification and a
link to OS notification settings. macOS development notifications belong to
Electron, not the installed OpenCode app. The two apps have separate settings
and builds. OS notification permissions and Focus/Do Not Disturb still apply.

For isolated integration testing, first ensure no other dev app uses CDP 9222:

```bash
OPENCODE_TEST_ONBOARDING=1 bunx electron-vite dev --inspect 9230
```

From the repository root:

```bash
bun packages/desktop/scripts/test-system-notifications.ts --foreground
bun packages/desktop/scripts/test-system-notifications.ts --foreground --native-click
```

The first command checks real sidecar permission/question events and callback
wiring, but uses a synthetic click. A native `show` callback alone is not proof
that a banner was visible. The second command never emits a synthetic click:
it waits for an actual notification-center/banner click before passing.

On macOS, NotificationCenter can accept a notification and still log
`muted by DND suppression: delay`. That means Focus/Do Not Disturb delayed its
presentation; an Electron `show` callback does not override that OS policy.
Do not disable Focus automatically or report banner visibility based only on
that callback.
