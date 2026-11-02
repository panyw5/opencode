import { Issue } from "./issue"

type Event = { directory: string; payload: { type: string; properties: Record<string, any> } }

/** Shared adapter for bridges that do not use the main session bus. */
export class IssueTracker {
  private messages = new Map<string, string>()
  constructor(private domain: string) {}

  observe(event: Event) {
    const props = event.payload.properties
    if (event.payload.type === "message.updated" && props.info?.role === "assistant") {
      this.messages.set(props.info.sessionID, props.info.id)
    }
    if (event.payload.type !== "session.error" || props.issueID) return
    const error = props.error as { name?: string; data?: { message?: string } } | undefined
    const result = Issue.record(event.directory, {
      source: this.domain,
      domain: this.domain,
      scope: "session",
      code: "bridge.run_failed",
      state: error?.name === "MessageAbortedError" ? "cancelled" : "failed",
      sessionID: props.sessionID,
      messageID: this.messages.get(props.sessionID),
      message: error?.data?.message ?? "External agent request failed",
    })
    props.issueID = result.issue.id
  }
}
