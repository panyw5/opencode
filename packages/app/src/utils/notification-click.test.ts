import { afterEach, describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  handleNotificationClick,
  setNavigate,
  QUICK_ASSISTANT_NOTIFICATION_EVENT,
  type AssistantNotificationTarget,
} from "./notification-click"

describe("notification click", () => {
  afterEach(() => {
    setNavigate(undefined as any)
  })

  test("navigates via registered navigate function", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick("/abc/session/123")
    expect(calls).toEqual(["/abc/session/123"])
  })

  test("does not navigate when href is missing", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick(undefined)
    expect(calls).toEqual([])
  })

  test("lets the quick assistant consume a session notification without navigating", () => {
    const calls: string[] = []
    const targets: AssistantNotificationTarget[] = []
    const directory = "/config/quick-assistant"
    const listener = (event: Event) => {
      targets.push((event as CustomEvent<AssistantNotificationTarget>).detail)
      event.preventDefault()
    }
    setNavigate((href) => calls.push(href))
    window.addEventListener(QUICK_ASSISTANT_NOTIFICATION_EVENT, listener)
    try {
      handleNotificationClick(`/${base64Encode(directory)}/session/ses_quick`)
      expect(targets).toEqual([{ directory, session: "ses_quick" }])
      expect(calls).toEqual([])
    } finally {
      window.removeEventListener(QUICK_ASSISTANT_NOTIFICATION_EVENT, listener)
    }
  })

  test("keeps normal project and project-only notification navigation", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    const base = `/${base64Encode("/projects/quick-assistant")}`
    handleNotificationClick(`${base}/session/ses_project`)
    handleNotificationClick(base)
    expect(calls).toEqual([`${base}/session/ses_project`, base])
  })

  test("falls back to location.assign without registered navigate", () => {
    handleNotificationClick("/abc/session/123")
    // falls back to window.location.assign — no error thrown
  })
})
