import { createSessionDiffService } from "./session-diff-service"
import { createSessionInfoService } from "./session-info-service"
import { createSessionMessagesService } from "./session-messages-service"
import type { SessionDataMutation } from "./session-data-event"
import type { SessionControllerDeps } from "./session-service-types"
import { createSessionStatusService } from "./session-status-service"
import { createSessionTodoService } from "./session-todo-service"

export function createSessionService(deps: SessionControllerDeps) {
  const info = createSessionInfoService(deps)
  const messages = createSessionMessagesService(deps)
  const todo = createSessionTodoService(deps)
  const diff = createSessionDiffService(deps)
  const status = createSessionStatusService(deps)
  const { clear: clearInfo, clearDirectory: clearInfoDirectory, clearDomain, ...infoApi } = info
  const {
    event: messageEvent,
    clear: clearMessages,
    clearDirectory: clearMessageDirectory,
    inspect: _inspectMessages,
    ...messagesApi
  } = messages
  const { event: todoEvent, clear: clearTodo, clearDirectory: clearTodoDirectory, inspect: _inspectTodo, ...todoApi } = todo
  const { event: diffEvent, clear: clearDiff, clearDirectory: clearDiffDirectory, inspect: _inspectDiff, ...diffApi } = diff
  const { clearDirectory: clearStatusDirectory, inspect: _inspectStatus, ...statusApi } = status

  return {
    api: {
      clear(directory: string, sessionIDs: string[]) {
        clearInfo(directory, sessionIDs)
        clearMessages(directory, sessionIDs)
        clearTodo(directory, sessionIDs)
        clearDiff(directory, sessionIDs)
      },
      info: infoApi,
      messages: messagesApi,
      todo: todoApi,
      diff: diffApi,
      status: statusApi,
    },
    event(directory: string, mutation: SessionDataMutation) {
      if (mutation.kind === "messages") messageEvent(directory, mutation.sessionID, mutation.strategy)
      if (mutation.kind === "todo") todoEvent(directory, mutation.sessionID)
      if (mutation.kind === "diff") diffEvent(directory, mutation.sessionID)
    },
    clearDirectory(directory: string) {
      clearInfoDirectory(directory)
      clearMessageDirectory(directory)
      clearTodoDirectory(directory)
      clearDiffDirectory(directory)
      clearStatusDirectory(directory)
    },
    clearDomain,
  }
}
