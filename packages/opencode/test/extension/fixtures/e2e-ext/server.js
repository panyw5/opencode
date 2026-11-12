// Minimal self-contained server extension consumed by
// test/extension/e2e-lifecycle.test.ts. It is packed into a local .tgz and
// installed through the real installer, so it must stay dependency-free: the
// installed package has no node_modules to resolve imports from. Modelled on
// packages/extensions/hello-viewer (echo RPC, one tool, host.emit events,
// lazily spawned host-managed child process cleaned up by dispose).
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const EXTENSION_ID = "test.e2e-ext"
const PING_EVENT = `${EXTENSION_ID}/ping`
// Keeps the child alive until killed; both `node -e` and `bun -e` run it.
const CHILD_SCRIPT = "setInterval(() => {}, 60 * 1000)"

function isRunning(child) {
  return child !== undefined && !child.exited && !child.killed
}

/** Managed via host.spawn: the runtime reaps the group on generation teardown. */
function startChild(state, host) {
  if (isRunning(state.child)) return state.child
  const child = host.spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "ignore", "ignore"],
  })
  child.onError(() => {
    if (state.child === child) state.child = undefined
  })
  child.onExit(() => {
    if (state.child === child) state.child = undefined
  })
  state.child = child
  return child
}

/** TERM with a KILL fallback; resolves only after the exit was observed. */
async function stopChild(state) {
  const child = state.child
  if (!child) return false
  state.child = undefined
  if (child.exited) return true
  child.kill("TERM")
  await new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      child.kill("KILL")
      setTimeout(finish, 250).unref?.()
    }, 1_000)
    timer.unref?.()
    child.onExit(finish)
  })
  return true
}

export default {
  id: EXTENSION_ID,

  /**
   * Process-level service. Activation is cheap: the demo child only exists
   * while `child.start` has been called, and `dispose` always stops it so the
   * test can assert that disable/update/uninstall leave no processes behind.
   */
  async activate(host) {
    const state = { child: undefined }
    // Prove dataDir is writable and leave a marker the test can check after
    // uninstall (non-purge uninstall must retain extension data).
    await mkdir(host.dataDir, { recursive: true })
    await writeFile(path.join(host.dataDir, "e2e.txt"), `owned by ${EXTENSION_ID}@${host.version}\n`)

    return {
      rpc: {
        echo: async (input) => ({
          echo: typeof input?.message === "string" ? input.message : "",
          extension: EXTENSION_ID,
          version: host.version,
        }),
        version: async () => host.version,
        "emit.ping": async (input, ctx) => {
          const payload = {
            source: "rpc",
            message: typeof input?.message === "string" ? input.message : "ping",
          }
          host.emit(PING_EVENT, payload, { directory: ctx.directory })
          return payload
        },
        "child.start": async () => {
          const child = startChild(state, host)
          return { running: true, pid: child.pid ?? -1 }
        },
        "child.pid": async () => ({ pid: state.child?.pid ?? null }),
      },
      dispose: async () => {
        await stopChild(state)
      },
    }
  },

  /**
   * Instance-level hooks: exactly one tool, surfaced through Plugin.list into
   * the ToolRegistry. Executing it also emits an event so a tool call is
   * observable on the bus.
   */
  async server(input) {
    return {
      tool: {
        e2e_ping: {
          description: "Ping the e2e fixture extension and echo the input back.",
          // Plain JSON-schema args (no zod available in the installed package).
          args: {
            text: { type: "string", description: "Text to echo back" },
          },
          execute: async (args, ctx) => {
            const text = typeof args?.text === "string" ? args.text : "pong"
            const message = `e2e-pong:${text}`
            input.extension.emit(PING_EVENT, {
              source: "tool",
              message,
              sessionID: ctx.sessionID,
            })
            return { title: "e2e ping", output: message, metadata: { echoed: text } }
          },
        },
      },
      dispose: async () => {},
    }
  },
}
