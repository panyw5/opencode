import { Effect, Schema } from "effect"

export const unavailable = Symbol("instructions-unavailable")
export type Unavailable = typeof unavailable
export type Source = {
  key: string
  read: (previous?: unknown) => Effect.Effect<unknown | Unavailable>
  decode: (value: unknown) => unknown
  keep: (value: unknown) => unknown
  initial: (value: unknown) => string
  changed: (previous: unknown, current: unknown) => string
}

export function make<A>(input: {
  key: string
  schema: Schema.Decoder<A>
  read: (previous?: A) => Effect.Effect<A | Unavailable>
  keep?: (value: A) => A
  initial: (value: A) => string
  changed: (previous: A, current: A) => string
}): Source {
  const decode = Schema.decodeUnknownSync(input.schema)
  return {
    key: input.key,
    read: (previous) => input.read(previous === undefined ? undefined : decode(previous)),
    decode,
    keep: (value) => (input.keep ? input.keep(decode(value)) : decode(value)),
    initial: (value) => input.initial(decode(value)),
    changed: (previous, current) => input.changed(decode(previous), decode(current)),
  }
}

export function diffByKey<A>(
  before: readonly A[],
  after: readonly A[],
  key: (value: A) => string,
  changed: (a: A, b: A) => boolean,
) {
  const old = new Map(before.map((value) => [key(value), value]))
  const current = new Set(after.map(key))
  return {
    added: after.filter((value) => !old.has(key(value))),
    removed: before.filter((value) => !current.has(key(value))),
    changed: after.flatMap((value) => {
      const previous = old.get(key(value))
      return previous === undefined || !changed(previous, value) ? [] : [{ previous, current: value }]
    }),
  }
}

export * as InstructionSource from "./instruction-source"
