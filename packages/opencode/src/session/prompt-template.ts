import { randomUUID } from "node:crypto"

const PLACEHOLDER = /(?<![$\{])\$(ARGUMENTS|\d+)/g
const NUMBER_PLACEHOLDER = /(?<![$\{])\$(\d+)/g

function placeholderMatches(text: string) {
  return Array.from(text.matchAll(PLACEHOLDER)).filter((match) => {
    const name = match[1]
    if (name !== "ARGUMENTS") return true
    const end = (match.index ?? 0) + match[0].length
    return !/[A-Za-z0-9_]/.test(text[end] ?? "")
  })
}

export type Segment = { kind: "text" | "shell"; value: string }

export function split(template: string): Segment[] {
  const result: Segment[] = []
  const expression = /!`([^`]+)`/g
  let cursor = 0
  for (const match of template.matchAll(expression)) {
    const start = match.index ?? 0
    if (start > cursor) result.push({ kind: "text", value: template.slice(cursor, start) })
    result.push({ kind: "shell", value: match[1] ?? "" })
    cursor = start + match[0].length
  }
  if (cursor < template.length) result.push({ kind: "text", value: template.slice(cursor) })
  return result
}

export function argumentsList(input: string): string[] {
  if (input.includes("\0")) throw new TypeError("Command arguments cannot contain a NUL byte")
  const result: string[] = []
  let value = ""
  let started = false
  let quote: "single" | "double" | undefined

  const push = () => {
    if (!started) return
    result.push(value)
    value = ""
    started = false
  }

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (!quote && !started) {
      const image = input.slice(i).match(/^\[Image\s+\d+\]/)
      if (image) {
        result.push(image[0])
        i += image[0].length - 1
        continue
      }
    }

    if (quote === "single") {
      if (char === "'") quote = undefined
      else if (char === "\\" && input[i + 1] === "'") value += input[++i]
      else value += char
      started = true
      continue
    }
    if (quote === "double") {
      if (char === '"') {
        quote = undefined
        started = true
        continue
      }
      if (char === "\\" && i + 1 < input.length) {
        const next = input[i + 1]
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          value += next
          i++
        } else {
          value += char
        }
        started = true
        continue
      }
      value += char
      started = true
      continue
    }

    if (/\s/.test(char)) {
      push()
      continue
    }
    if (char === "'") {
      quote = "single"
      started = true
      continue
    }
    if (char === '"') {
      quote = "double"
      started = true
      continue
    }
    if (char === "\\" && i + 1 < input.length) {
      const next = input[i + 1]
      if (/\s/.test(next) || /[\\'"`$;&|<>()[\]{}*?!]/.test(next)) {
        value += next
        i++
      } else {
        value += char + next
        i++
      }
      started = true
      continue
    }
    value += char
    started = true
  }

  if (quote) throw new TypeError("Unterminated quote in command arguments")
  push()
  return result
}

export function placeholders(template: string, input: string, args: string[]) {
  const segments = split(template)
  const positions = segments.flatMap((segment) =>
    segment.kind === "shell"
      ? shellPlaceholders(segment.value).flatMap((match) => (/^\d+$/.test(match.name) ? [Number(match.name)] : []))
      : Array.from(segment.value.matchAll(NUMBER_PLACEHOLDER), (match) => Number(match[1])),
  )
  const last = positions.length ? Math.max(...positions) : 0
  const argument = (position: number) => {
    if (position < 1 || position > args.length) return ""
    if (position === last) return args.slice(position - 1).join(" ")
    return args[position - 1] ?? ""
  }
  const replace = (text: string) => {
    let output = ""
    let cursor = 0
    for (const match of placeholderMatches(text)) {
      const start = match.index ?? 0
      output += text.slice(cursor, start)
      const name = match[1] ?? ""
      output += name === "ARGUMENTS" ? input : argument(Number(name))
      cursor = start + match[0].length
    }
    return output + text.slice(cursor)
  }
  return {
    replace,
    argument,
    hasArguments: segments.some((segment) =>
      segment.kind === "shell"
        ? shellPlaceholders(segment.value).some((match) => match.name === "ARGUMENTS")
        : placeholderMatches(segment.value).some((match) => match[1] === "ARGUMENTS"),
    ),
    hasNumbers: positions.length > 0,
  }
}

export function usesNumericArguments(template: string) {
  return placeholders(template, "", []).hasNumbers
}

type ShellPlaceholder = { start: number; end: number; name: string; quote?: "single" | "double" }

function shellPlaceholders(source: string): ShellPlaceholder[] {
  const result: ShellPlaceholder[] = []
  let quote: "single" | "double" | undefined
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === "\\" && source[i + 1] === "$") {
      i++
      continue
    }
    if (char === "\\" && quote !== "single") {
      i++
      continue
    }
    if (char === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single"
      continue
    }
    if (char === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double"
      continue
    }
    if (char !== "$" || source[i - 1] === "$") continue
    const match = source.slice(i).match(/^\$(ARGUMENTS|\d+)/)
    if (!match) continue
    const name = match[1] ?? ""
    const end = i + match[0].length
    if (name === "ARGUMENTS" && /[A-Za-z0-9_]/.test(source[end] ?? "")) continue
    result.push({ start: i, end, name, quote })
    i = end - 1
  }
  return result
}

function rejectHeredocPlaceholders(source: string) {
  const lines = source.split(/(?<=\n)/)
  let pending: Array<{ delimiter: string; stripTabs: boolean }> = []
  let index = 0
  while (index < lines.length) {
    if (pending.length) {
      for (const item of pending) {
        let body = ""
        let found = false
        while (index < lines.length) {
          const line = (lines[index++] ?? "").replace(/\r?\n$/, "")
          const compare = item.stripTabs ? line.replace(/^\t+/, "") : line
          if (compare === item.delimiter) {
            found = true
            break
          }
          body += line + "\n"
        }
        if (/(?<!\\)(?<![$\{])\$(ARGUMENTS|\d+)/.test(body)) {
          throw new TypeError("Argument placeholders inside shell heredocs are not supported")
        }
        if (!found) return
      }
      pending = []
      continue
    }

    const line = lines[index++] ?? ""
    pending = Array.from(line.matchAll(/<<(?!<)(-)?[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))/g), (match) => ({
      delimiter: match[2] ?? match[3] ?? match[4] ?? "",
      stripTabs: Boolean(match[1]),
    }))
  }
}

export function bindShell(
  source: string,
  input: string,
  args: string[],
  shell: string,
  wholeTemplate = source,
  variablePrefix = `OPENCODE_TEMPLATE_${randomUUID().replaceAll("-", "").toUpperCase()}`,
) {
  if (source.includes("\0") || input.includes("\0") || args.some((arg) => arg.includes("\0"))) {
    throw new TypeError("Shell template and arguments cannot contain a NUL byte")
  }

  const values = placeholders(wholeTemplate, input, args)
  const occurrences = shellPlaceholders(source)
  if (occurrences.length === 0) return { source, env: {} as NodeJS.ProcessEnv }
  rejectHeredocPlaceholders(source)
  if (!["bash", "dash", "ksh", "sh", "zsh"].includes(shell)) {
    throw new TypeError(`Template shell argument placeholders are not supported by ${shell}`)
  }

  const env: NodeJS.ProcessEnv = {}
  const names = new Map<string, string>()
  const nameFor = (name: string) => {
    const key = `${variablePrefix}_${name === "ARGUMENTS" ? "ARGUMENTS" : `ARG_${name}`}`
    if (!names.has(name)) {
      names.set(name, key)
      env[key] = name === "ARGUMENTS" ? input : values.argument(Number(name))
    }
    return key
  }

  let cursor = 0
  let result = ""
  for (const item of occurrences) {
    result += source.slice(cursor, item.start)
    const variable = `\${${nameFor(item.name)}}`
    result += item.quote === "single" ? `'"${variable}"'` : item.quote === "double" ? variable : `"${variable}"`
    cursor = item.end
  }
  result += source.slice(cursor)
  return { source: result, env }
}

export * as PromptTemplate from "./prompt-template"
