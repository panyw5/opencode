import { defineRpc, type StandardSchemaV1 } from "@opencode-ai/extension-kit/rpc"

/**
 * RPC contract shared by hello-viewer's server and web parts. Declared once
 * here so `defineRpc` keeps the server handler map and the web-side caller
 * in sync — renaming a method or changing a payload fails typecheck on both
 * ends instead of drifting apart at runtime.
 */
export type Contract = {
  echo: { input: { message?: string }; output: { echo: string; extension: string; at: string } }
  greet: { input: { message?: string }; output: { message: string; from: string; at: string } }
  "child.start": { input: undefined; output: { running: boolean; pid: number } }
  "child.ping": { input: { text?: string }; output: { echoed: string } }
  "child.stop": { input: undefined; output: { stopped: boolean } }
}

export const rpc = defineRpc<Contract>()

/**
 * Minimal hand-rolled Standard Schema V1 validator: the input must be an
 * object and every declared field, when present, must be a string. It exists
 * to show the protocol shape without pulling a schema library into the
 * example — a zod/valibot/arktype schema can be dropped in unchanged.
 */
function optionalStrings<Key extends string>(...keys: Key[]): StandardSchemaV1<unknown, Partial<Record<Key, string>>> {
  return {
    "~standard": {
      version: 1,
      vendor: "example.hello-viewer",
      validate(value) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return { issues: [{ message: "expected an object" }] }
        }
        const out: Partial<Record<Key, string>> = {}
        for (const key of keys) {
          const field = (value as Record<string, unknown>)[key]
          if (field === undefined) continue
          if (typeof field !== "string") {
            return { issues: [{ message: "must be a string", path: [key] }] }
          }
          out[key] = field
        }
        return { value: out }
      },
    },
  }
}

export const messageInput = optionalStrings("message")
export const textInput = optionalStrings("text")
