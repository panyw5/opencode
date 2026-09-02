# Repo
push ONLY to my fork `panyw5/opencode`

run github action only with my fork `panyw5/opencode`

# MANDATORY RULES

There are several opencode instances:
- installed desktop app (`/applications/opencode.app`)
- installed official cli (`/opt/homebrew/bin/opencode`)
- development electron app for testing (`bun run dev:desktop`)

## Using the development electron app
- Run **frontend** tests using CDP 9222: you can control **electron** app, spawn one if not running
  **VERIFY** if there is electron app running **before** launching
- DO NOT shut down the installed opencode app (`/applications/opencode.app`).
- CDP helper (dev renderer only, does not launch or quit apps):
  ```
  bun packages/desktop/scripts/cdp.ts targets
  bun packages/desktop/scripts/cdp.ts info
  bun packages/desktop/scripts/cdp.ts eval 'document.title'
  bun packages/desktop/scripts/cdp.ts click 'New session'
  bun packages/desktop/scripts/cdp.ts screenshot /tmp/opencode-cdp.png
  ```

Obey the following rules at all times:
- Read backend logs YOURSELF!!!! You are forbidden to ask user to read backend log for you!!!!
- When fixing bug: ADD LOGS AT EVERY STEP!!!! ASSUME YOU ARE MORON, AND NEED LOGS TO DO ANY DEBUGGING
- YOU yourself must perform SIDECAR functionality testing. YOU ARE FORBIDDEN to ask user to perform sidecar functionality testing for you!!!!
  - SEND MESSAGES YOURSELF
  - VERIFY RECEIVED MESSAGES YOURSELF
  - ADD LOGS YOURSELF
- If the user provided a project path and a session id: **look up** the session database to understand the actual situation and identify the problem, BEFORE reading and modifying the codebase