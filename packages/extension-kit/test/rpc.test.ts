import { describe, expect, test } from "bun:test"
import {
  defineRpc,
  ExtensionRpcError,
  type RpcHandlerContext,
  type StandardSchemaV1,
} from "../src/rpc"
import type { ExtensionService } from "../src/server"
import type { ExtensionRpc, ExtensionRpcOptions } from "../src/web"

type Contract = {
  echo: { input: { message?: string }; output: { echo: string } }
  greet: { input: { name: string }; output: { greeting: string } }
  "child.start": { input: undefined; output: { running: boolean } }
}

const rpc = defineRpc<Contract>()

const signal = new AbortController().signal

// Standard Schema V1 validator hand-rolled for tests: accepts objects whose
// every declared field is a string, rejects everything else.
function objectOfStrings<Key extends string>(required: Key[]): StandardSchemaV1<unknown, Record<Key, string>> {
  return {
    "~standard": {
      version: 1,
      vendor: "extension-kit-test",
      validate(value) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return { issues: [{ message: "expected an object" }] }
        }
        const out = {} as Record<Key, string>
        for (const key of required) {
          const field = (value as Record<string, unknown>)[key]
          if (typeof field !== "string") {
            return { issues: [{ message: `expected a string`, path: [key] }] }
          }
          out[key] = field
        }
        return { value: out }
      },
    },
  }
}

describe("extension-kit defineRpc", () => {
  test("typed call binds method input and output to the bridge", async () => {
    const calls: Array<{ method: string; input: unknown; options?: ExtensionRpcOptions }> = []
    const bridge: ExtensionRpc = {
      call: async <T,>(method: string, input?: unknown, options?: ExtensionRpcOptions): Promise<T> => {
        calls.push({ method, input, options })
        const result =
          method === "echo" ? { echo: "hi" } : method === "greet" ? { greeting: "hi ada" } : { running: true }
        return result as T
      },
    }
    const call = rpc.bind(bridge)

    const echo = await call("echo", { message: "hi" })
    const echoCheck: { echo: string } = echo
    expect(echoCheck.echo).toBe("hi")

    const greet = await call("greet", { name: "ada" }, { directory: "/tmp/project" })
    const greetCheck: { greeting: string } = greet
    expect(greetCheck.greeting).toBe("hi ada")

    // `input: undefined` makes the argument optional.
    const started = await call("child.start")
    const startedCheck: { running: boolean } = started
    expect(startedCheck.running).toBe(true)

    expect(calls.map((entry) => entry.method)).toEqual(["echo", "greet", "child.start"])
    expect(calls[1]!.options?.directory).toBe("/tmp/project")

    // @ts-expect-error unknown method names are rejected
    void call("missing", {})
    // @ts-expect-error wrong input shapes are rejected
    void call("echo", { message: 1 })
    // @ts-expect-error required input cannot be omitted
    void call("greet")
    // @ts-expect-error extra input fields are rejected
    void call("greet", { name: "ada", extra: true })
  })

  test("handlers wrap the map into the ExtensionService rpc record shape", async () => {
    const handlers = rpc.handlers({
      echo: async (input, ctx) => {
        const check: { message?: string } = input
        const ctxCheck: RpcHandlerContext = ctx
        return { echo: `${check.message ?? ""}@${ctxCheck.directory ?? ""}` }
      },
      greet: {
        input: objectOfStrings(["name"]),
        handle: async (input) => ({ greeting: `hi ${input.name}` }),
      },
      "child.start": async () => ({ running: true }),
    })

    // The wrapped record satisfies the existing untyped service contract.
    const service: ExtensionService = { rpc: handlers }
    expect(Object.keys(service.rpc!).toSorted()).toEqual(["child.start", "echo", "greet"])

    expect(await service.rpc!["echo"]!({ message: "ping" }, { signal, directory: "/tmp" })).toEqual({
      echo: "ping@/tmp",
    })
    expect(await service.rpc!["child.start"]!(undefined, { signal })).toEqual({ running: true })

    // @ts-expect-error every contract method must be implemented
    rpc.handlers({ echo: async () => ({ echo: "" }) })
    rpc.handlers({
      echo: async () => ({ echo: "" }),
      greet: async () => ({ greeting: "" }),
      "child.start": async () => ({ running: true }),
      // @ts-expect-error extra methods outside the contract are rejected
      bonus: async () => ({}),
    })
    rpc.handlers({
      // @ts-expect-error handler outputs must match the contract
      echo: async () => ({ pong: "" }),
      greet: async () => ({ greeting: "" }),
      "child.start": async () => ({ running: true }),
    })
  })

  test("schema-validated handlers receive the validated value", async () => {
    const seen: unknown[] = []
    const handlers = rpc.handlers({
      echo: async () => ({ echo: "" }),
      greet: {
        // The validator coerces: non-name fields are stripped.
        input: objectOfStrings(["name"]),
        handle: async (input) => {
          seen.push(input)
          return { greeting: `hi ${input.name}` }
        },
      },
      "child.start": async () => ({ running: true }),
    })
    expect(await handlers["greet"]!({ name: "ada", extra: "dropped" }, { signal })).toEqual({ greeting: "hi ada" })
    expect(seen).toEqual([{ name: "ada" }])
  })

  test("schema validation failure rejects with invalid_input", async () => {
    const handlers = rpc.handlers({
      echo: async () => ({ echo: "" }),
      greet: {
        input: objectOfStrings(["name"]),
        handle: async () => ({ greeting: "unreachable" }),
      },
      "child.start": async () => ({ running: true }),
    })

    for (const input of [null, "nope", { name: 1 }]) {
      const error = await handlers["greet"]!(input, { signal }).then(
        () => undefined,
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(ExtensionRpcError)
      expect((error as ExtensionRpcError).code).toBe("invalid_input")
      expect((error as ExtensionRpcError).message).toContain('invalid input for "greet"')
    }

    const error = await handlers["greet"]!({ name: 1 }, { signal }).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect((error as ExtensionRpcError).message).toContain("name: expected a string")
  })

  test("handlers without schemas keep receiving the raw input", async () => {
    const seen: unknown[] = []
    const handlers = rpc.handlers({
      echo: async (input) => {
        seen.push(input)
        return { echo: "" }
      },
      greet: async () => ({ greeting: "" }),
      "child.start": async () => ({ running: true }),
    })
    const weird = { message: 1, nested: { ok: true } }
    await handlers["echo"]!(weird, { signal })
    expect(seen).toEqual([weird])
  })
})
