import type { Message, Part, Todo, ToolPart } from "@opencode-ai/sdk/v2"
import { normalizeTool } from "./tool-meta"

export type TodoSnapshotRow = {
  todo: Todo
  change?: "added" | "modified" | "removed"
  gapBefore?: boolean
}

function sameTodo(a: Todo, b: Todo) {
  return a.content === b.content && a.status === b.status && a.priority === b.priority
}

function todoList(part: ToolPart): Todo[] {
  const state = part.state
  if (state.status !== "pending" && Array.isArray(state.metadata?.todos)) return state.metadata.todos as Todo[]
  return Array.isArray(state.input?.todos) ? (state.input.todos as Todo[]) : []
}

function todoPart(part: Part): part is ToolPart {
  return part.type === "tool" && normalizeTool(part.tool) === "todowrite"
}

export function previousTodoList(
  messages: readonly Message[],
  parts: Record<string, Part[] | undefined>,
  current: ToolPart,
) {
  let previous: Todo[] | undefined

  for (const message of messages) {
    for (const part of parts[message.id] ?? []) {
      if (part.id === current.id) return previous
      if (todoPart(part)) previous = todoList(part)
    }
  }

  return previous
}

type Operation = TodoSnapshotRow & { changed: boolean }

/**
 * Build a compact, line-oriented snapshot. Matching content stays aligned when
 * tasks are inserted or removed; a one-for-one text replacement remains a
 * modification instead of becoming separate delete/add rows.
 */
export function todoSnapshot(previous: readonly Todo[] | undefined, current: readonly Todo[]): TodoSnapshotRow[] {
  if (previous === undefined) return current.map((todo) => ({ todo }))

  const rows = previous.length + 1
  const columns = current.length + 1
  const cost = Array.from({ length: rows }, () => Array<number>(columns).fill(0))

  for (let i = previous.length; i >= 0; i -= 1) {
    for (let j = current.length; j >= 0; j -= 1) {
      if (i === previous.length) {
        cost[i][j] = current.length - j
        continue
      }
      if (j === current.length) {
        cost[i][j] = previous.length - i
        continue
      }
      if (previous[i].content === current[j].content) {
        cost[i][j] = cost[i + 1][j + 1]
        continue
      }
      cost[i][j] = Math.min(cost[i + 1][j] + 1, cost[i][j + 1] + 1, cost[i + 1][j + 1] + 1.5)
    }
  }

  const operations: Operation[] = []
  let i = 0
  let j = 0
  while (i < previous.length || j < current.length) {
    const before = previous[i]
    const after = current[j]
    if (before && after && before.content === after.content) {
      const changed = !sameTodo(before, after)
      operations.push({ todo: after, change: changed ? "modified" : undefined, changed })
      i += 1
      j += 1
      continue
    }

    const remove = before ? cost[i + 1][j] + 1 : Number.POSITIVE_INFINITY
    const add = after ? cost[i][j + 1] + 1 : Number.POSITIVE_INFINITY
    const modify = before && after ? cost[i + 1][j + 1] + 1.5 : Number.POSITIVE_INFINITY
    const best = Math.min(remove, add, modify)

    if (modify === best) {
      operations.push({ todo: after, change: "modified", changed: true })
      i += 1
      j += 1
      continue
    }
    if (add === best) {
      operations.push({ todo: after, change: "added", changed: true })
      j += 1
      continue
    }
    operations.push({ todo: before, change: "removed", changed: true })
    i += 1
  }

  const visible = new Set<number>()
  operations.forEach((row, index) => {
    if (!row.changed) return
    visible.add(index - 1)
    visible.add(index)
    visible.add(index + 1)
  })

  let last = -2
  return operations.flatMap<TodoSnapshotRow>((row, index) => {
    if (!visible.has(index)) return []
    const result = { todo: row.todo, change: row.change, gapBefore: last >= 0 && index > last + 1 }
    last = index
    return [result]
  })
}
