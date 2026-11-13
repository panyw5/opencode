import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

/**
 * Fixture extension server entry for the T5.2 host-process tests. Exercises
 * the full proxied surface: service/instance rpc, tools (metadata/ask/abort),
 * emit, settings push, timers, spawn and the throwing input stubs.
 */

export default {
  id: "test.fixture-ext",
  async activate(host) {
    host.settings.onDidChange((next) => {
      host.emit("fixture.settings.seen", { next })
    })
    return {
      rpc: {
        echo: async (input) => input,
        "settings.get": async () => host.settings.get(),
        emit: async (input) => {
          host.emit("fixture.event", input?.data ?? null, input?.options)
          return "emitted"
        },
        "log.write": async (input) => {
          const level = input?.level ?? "info"
          host.log[level](input?.message ?? "fixture log", input?.extra)
          return "logged"
        },
        timer: async (input) => {
          host.setTimeout(() => host.emit("fixture.timer", { after: input?.delay ?? 0 }), input?.delay ?? 5)
          return "scheduled"
        },
        interval: async (input) => {
          let ticks = 0
          host.setInterval(() => {
            ticks++
            host.emit("fixture.interval", { ticks })
          }, input?.delay ?? 5)
          return "scheduled"
        },
        "timer.throw": async () => {
          host.setTimeout(() => {
            throw new Error("fixture timer boom")
          }, 5)
          return "scheduled"
        },
        "rpc.error": async () => {
          const error = new Error("fixture domain failure")
          error.name = "ExtensionRpcError"
          error.code = "domain_code"
          throw error
        },
        hold: async (_input, ctx) => {
          process.stderr.write("fixture-hold-entered\n")
          await new Promise((resolve) => {
            if (ctx.signal.aborted) return resolve()
            ctx.signal.addEventListener("abort", resolve, { once: true })
          })
          return "released"
        },
        "spawn.echo": async (input) => {
          const child = host.spawn("cat", [], { stdio: ["pipe", "pipe", "ignore"] })
          const chunks = []
          child.stdout.on("data", (chunk) => chunks.push(chunk))
          const done = new Promise((resolve) => child.onExit((code, signal) => resolve({ code, signal })))
          child.stdin.write(input?.text ?? "")
          child.stdin.end()
          const exit = await done
          return { output: Buffer.concat(chunks).toString(), exit, pid: child.pid }
        },
        "spawn.kill": async () => {
          const child = host.spawn("sleep", ["30"])
          const done = new Promise((resolve) => child.onExit((code, signal) => resolve({ code, signal })))
          child.kill("KILL")
          const exit = await done
          return { pid: child.pid, exit, killed: child.killed, exited: child.exited }
        },
        "spawn.fail": async () => {
          const child = host.spawn("/nonexistent-fixture-binary-xyz", [], {})
          const error = await new Promise((resolve) => child.onError((cause) => resolve(String(cause.message ?? cause))))
          return { error, exited: child.exited }
        },
        "spawn.many": async (input) => {
          // Emit >initial credit (256 KiB) of stdout to prove the credit loop.
          const child = host.spawn("cat", [input?.file ?? "/dev/zero"], { stdio: ["ignore", "pipe", "ignore"] })
          let received = 0
          child.stdout.on("data", (chunk) => {
            received += chunk.length
            if (received >= (input?.bytes ?? 0)) child.kill("KILL")
          })
          const exit = await new Promise((resolve) => child.onExit((code, signal) => resolve({ code, signal })))
          return { received, exit }
        },
      },
      dispose: async () => {
        process.stderr.write("fixture-service-disposed\n")
      },
    }
  },
  async server(input) {
    return {
      rpc: {
        "instance.echo": async (value, ctx) => ({ value, directory: ctx.directory ?? input.directory }),
        "input.probe": async (_value, ctx) => ({
          directory: input.directory,
          worktree: input.worktree,
          serverUrl: input.serverUrl?.href,
          hasService: Boolean(input.extension?.service),
          ctxDirectory: ctx.directory,
        }),
        "input.client": async () => {
          try {
            void input.client.session
            return "no-throw"
          } catch (cause) {
            return String(cause.message ?? cause)
          }
        },
        "input.dollar": async () => {
          try {
            void input.$("x")
            return "no-throw"
          } catch (cause) {
            return String(cause.message ?? cause)
          }
        },
        "input.workspace": async () => {
          try {
            input.experimental_workspace.register("fixture", {})
            return "no-throw"
          } catch (cause) {
            return String(cause.message ?? cause)
          }
        },
        "service.direct": async (value) => {
          const handler = input.extension.service?.rpc?.echo
          if (!handler) return "no-service"
          return handler(value, { signal: new AbortController().signal })
        },
      },
      event: async ({ event }) => {
        input.extension.emit("fixture.event.seen", { event })
      },
      tool: {
        greet: tool({
          description: "fixture greet",
          args: { name: z.string() },
          async execute(args, ctx) {
            ctx.metadata({ title: `greeted ${args.name}`, metadata: { who: args.name } })
            if (args.name === "ask") {
              await ctx.ask({ permission: "fixture", patterns: ["*"], always: ["*"], metadata: { q: 1 } })
            }
            if (args.name === "hold") {
              process.stderr.write("fixture-tool-hold-entered\n")
              await new Promise((resolve, reject) => {
                if (ctx.abort.aborted) return reject(new Error("tool aborted"))
                ctx.abort.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true })
              })
            }
            return {
              title: `hi ${args.name}`,
              output: `hello ${args.name}`,
              metadata: { session: ctx.sessionID, agent: ctx.agent, dir: ctx.directory },
            }
          },
        }),
      },
      dispose: async () => {
        process.stderr.write(`fixture-instance-disposed ${input.directory}\n`)
      },
    }
  },
}
