import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import z from "zod"

/**
 * Shared conversion of a plugin `tool({ args })` raw shape into the JSON
 * Schema exposed to the model. Extracted from `tool/registry.ts` so the
 * extension host worker (T5.2) can serialize tool parameters identically at
 * the process boundary — both sides must agree on the produced schema.
 */

export function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

export function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Compose the raw args record into one zod object when every entry is a zod
 * schema (duck-typed via `_zod` so bundled zod copies still match); returns
 * undefined when any entry is a legacy JSON Schema definition instead.
 */
export function pluginArgsZodObject(args: Record<string, unknown>): z.ZodType | undefined {
  const entries = Object.entries(args)
  if (!entries.every((entry) => isZodType(entry[1]))) return
  return z.object(args)
}

/**
 * JSON Schema for one tool's args record: all-zod shapes go through
 * `z.toJSONSchema`, anything else falls back to the legacy passthrough that
 * treats entries as raw JSON Schema definitions (registry.ts:311-321 parity).
 */
export function toolArgsJsonSchema(args: Record<string, unknown> | undefined): JSONSchema7 {
  const record = args ?? {}
  const zod = pluginArgsZodObject(record)
  if (zod) return zodJsonSchema(zod)
  return legacyJsonSchema(Object.entries(record))
}

export * as PluginToolSchema from "./tool-schema.ts"
