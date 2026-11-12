import type { RpcHandler } from "./server"
import type { ExtensionRpc, ExtensionRpcOptions } from "./web"

/**
 * Duck-typed RPC error the host runtime understands: an error shaped
 * `{ name: "ExtensionRpcError", code, message }` is normalized upstream and
 * surfaced to the web caller with its `code` preserved. Throw it from
 * handlers to report domain errors; `defineRpc` throws it with the
 * `"invalid_input"` code when a Standard Schema validator rejects the input.
 */
export class ExtensionRpcError extends Error {
  override readonly name = "ExtensionRpcError"

  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

/**
 * Minimal structural copy of the Standard Schema V1 protocol
 * (https://standardschema.dev). Validators from zod, valibot, arktype or any
 * other conforming library — or a hand-rolled object like the one below —
 * are accepted without depending on any of them:
 *
 * ```ts
 * const schema: StandardSchemaV1<unknown, { name: string }> = {
 *   "~standard": {
 *     version: 1,
 *     vendor: "my-extension",
 *     validate: (value) =>
 *       typeof (value as { name?: unknown })?.name === "string"
 *         ? { value: { name: (value as { name: string }).name } }
 *         : { issues: [{ message: '"name" must be a string', path: ["name"] }] },
 *   },
 * }
 * ```
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
  }
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaV1Issue> }

export type StandardSchemaV1Issue = {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

/**
 * A shared RPC contract between an extension's web and server parts. Declare
 * it once in a shared type file — `type Contract = { echo: { input: I;
 * output: O } }` — then hand it to `defineRpc<Contract>()` so the server
 * handler map and the web-side caller stay in sync. Methods that take no
 * input declare `input: undefined` (or `input: void`).
 */
export type RpcContract = Record<string, { input: unknown; output: unknown }>

export type RpcContractInput<Contract extends RpcContract, Method extends keyof Contract> = Contract[Method]["input"]

export type RpcContractOutput<Contract extends RpcContract, Method extends keyof Contract> = Contract[Method]["output"]

/** Context forwarded to every RPC handler by the host runtime. */
export type RpcHandlerContext = {
  directory?: string
  signal: AbortSignal
}

export type RpcMethodHandler<Input, Output> = (input: Input, ctx: RpcHandlerContext) => Output | Promise<Output>

/**
 * Handler with an optional Standard Schema validator. `input` runs before
 * `handle`; a failed validation rejects the call with an `ExtensionRpcError`
 * carrying the `"invalid_input"` code, and `handle` receives the validator's
 * (possibly coerced) `value` rather than the raw input.
 */
export type RpcMethodSpec<Input, Output> = {
  input?: StandardSchemaV1<unknown, Input>
  handle: RpcMethodHandler<Input, Output>
}

export type RpcMethod<Input, Output> = RpcMethodHandler<Input, Output> | RpcMethodSpec<Input, Output>

/**
 * Server-side view of a contract: one entry per method — either a bare
 * handler or `{ input?, handle }`. Every contract method must be implemented
 * and no extras are allowed, so renaming a method fails typecheck on both
 * sides.
 */
export type RpcHandlerMap<Contract extends RpcContract> = {
  [Method in keyof Contract]: RpcMethod<Contract[Method]["input"], Contract[Method]["output"]>
}

// Methods whose contract declares `input: undefined`/`void` take an optional
// call argument; all others require it.
type RpcCallArgs<Method extends { input: unknown }> = undefined extends Method["input"]
  ? [input?: Method["input"], options?: ExtensionRpcOptions]
  : [input: Method["input"], options?: ExtensionRpcOptions]

/**
 * Web-side view of a contract: `call(method, input)` resolves with the
 * method's declared output type.
 */
export type TypedRpcCall<Contract extends RpcContract> = <Method extends Extract<keyof Contract, string>>(
  method: Method,
  ...args: RpcCallArgs<Contract[Method]>
) => Promise<Contract[Method]["output"]>

export type DefinedRpc<Contract extends RpcContract> = {
  /**
   * Server side: wraps a fully typed handler map into the
   * `Record<string, RpcHandler>` shape `ExtensionService.rpc` and
   * `ExtensionHooks.rpc` expect. Handlers declared with an `input` schema are
   * validated before invocation.
   */
  handlers(map: RpcHandlerMap<Contract>): { [Method in Extract<keyof Contract, string>]: RpcHandler }
  /**
   * Web side: binds the contract to the host-provided `context.rpc` bridge.
   * The returned caller forwards to `rpc.call` unchanged — same method names,
   * same request path — but with typed input/output.
   */
  bind(rpc: ExtensionRpc): TypedRpcCall<Contract>
}

function formatIssues(issues: ReadonlyArray<StandardSchemaV1Issue>): string {
  return issues
    .map((issue) => {
      const path = issue.path
        ?.map((segment) => (typeof segment === "object" ? segment.key : segment))
        .filter((key) => key !== undefined)
        .join(".")
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join("; ")
}

function wrapMethod(method: string, definition: RpcMethod<unknown, unknown>): RpcHandler {
  if (typeof definition === "function") {
    return async (input, ctx) => definition(input, ctx)
  }
  const schema = definition.input
  return async (input, ctx) => {
    let value = input
    if (schema) {
      const result = await schema["~standard"].validate(input)
      if (result.issues) {
        const detail = formatIssues(result.issues)
        throw new ExtensionRpcError(
          "invalid_input",
          `invalid input for "${method}"${detail ? `: ${detail}` : ""}`,
        )
      }
      value = result.value
    }
    return definition.handle(value, ctx)
  }
}

/**
 * Creates a typed RPC helper pair for one contract. Typical usage in a
 * shared file:
 *
 * ```ts
 * export type Contract = { echo: { input: { message?: string }; output: { echo: string } } }
 * export const rpc = defineRpc<Contract>()
 * ```
 *
 * Server entry: `service.rpc = rpc.handlers({ echo: async (input) => ({ echo: input.message ?? "" }) })`
 * Web entry: `const call = rpc.bind(context.rpc); await call("echo", { message: "hi" })`
 *
 * The original untyped `rpc.call<T>(name, input)` keeps working alongside.
 */
export function defineRpc<Contract extends RpcContract>(): DefinedRpc<Contract> {
  return {
    handlers(map) {
      const record: Record<string, RpcHandler> = {}
      for (const [method, definition] of Object.entries(map)) {
        record[method] = wrapMethod(method, definition as RpcMethod<unknown, unknown>)
      }
      return record as { [Method in Extract<keyof Contract, string>]: RpcHandler }
    },
    bind(rpc) {
      return ((method: string, input?: unknown, options?: ExtensionRpcOptions) =>
        rpc.call(method, input, options)) as TypedRpcCall<Contract>
    },
  }
}
