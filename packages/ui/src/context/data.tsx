import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, Provider } from "@opencode-ai/sdk/v2"
import { createMemo } from "solid-js"
import { createSimpleContext } from "./helper"
import { buildTaskSessionLookup, type TaskSessionLookup } from "../components/message-task-session"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, Provider> | Provider[]
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export type AbortSessionFn = (sessionID: string) => void | Promise<void>

export type AdvisorInterventionFn = (input: {
  sessionID: string
  callID: string
  action: "start" | "message" | "finish"
  message?: string
}) => void | Promise<void>

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onAbortSession?: AbortSessionFn
    onAdvisorIntervention?: AdvisorInterventionFn
  }) => {
    // One shared lookup per sessions snapshot: task tool cards resolve their
    // child session through it instead of scanning the full session list.
    const taskLookup = createMemo(() => buildTaskSessionLookup(props.data.session))
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      get taskLookup(): TaskSessionLookup {
        return taskLookup()
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      abortSession: props.onAbortSession,
      advisorIntervention: props.onAdvisorIntervention,
    }
  },
})
