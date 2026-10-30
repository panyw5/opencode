import type { Tool } from "@/tool/tool"
import type { Entry } from "./code-mode"

const object = { type: "object" } as const
const array = { type: "array", items: object } as const
const data: Record<string, Entry["schema"]> = {
  glob: {
    type: "object",
    properties: { files: { type: "array", items: { type: "string" } }, truncated: { type: "boolean" } },
  },
  grep: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, line: { type: "number" }, text: { type: "string" } },
        },
      },
      total: { type: "number" },
      truncated: { type: "boolean" },
      partial: { type: "boolean" },
    },
  },
  read: {
    type: "object",
    properties: {
      type: { enum: ["file", "directory", "attachment"] },
      path: { type: "string" },
      lines: {
        type: "array",
        items: { type: "object", properties: { line: { type: "number" }, text: { type: "string" } } },
      },
      entries: { type: "array", items: { type: "string" } },
      offset: { type: "number" },
      nextOffset: { type: "number" },
      truncated: { type: "boolean" },
    },
  },
  lsp: { type: "object", properties: { result: array } },
  task_list: { type: "object", properties: { tasks: array, count: { type: "number" } } },
  task_transcript: {
    type: "object",
    properties: { messages: array, more: { type: "boolean" }, next_cursor: { type: "string" } },
  },
  session_transcript: {
    type: "object",
    properties: { messages: array, more: { type: "boolean" }, next_cursor: { type: "string" } },
  },
  browser_read: { type: "object", properties: { nodes: array, url: { type: "string" }, title: { type: "string" } } },
  browser_console: { type: "object", properties: { entries: array, url: { type: "string" } } },
}

export function outputSchema(name: string): Entry["schema"] {
  return {
    type: "object",
    required: ["output", "metadata"],
    properties: { output: { type: "string" }, metadata: object, data: data[name] ?? {} },
  }
}

export function result(value: Tool.ExecuteResult) {
  return { output: value.output, metadata: value.metadata, ...(value.data === undefined ? {} : { data: value.data }) }
}

export * as CodeModeQuery from "./code-mode-query"
