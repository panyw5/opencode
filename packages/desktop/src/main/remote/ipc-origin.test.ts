import { expect, test } from "bun:test"
import { isTrustedRemoteRendererUrl } from "./ipc-origin"

test("renderer origin policy trusts packaged and configured dev origins only", () => {
  expect(isTrustedRemoteRendererUrl("oc://renderer/index.html", undefined)).toBe(true)
  expect(isTrustedRemoteRendererUrl("http://127.0.0.1:5173/settings", "http://127.0.0.1:5173/")).toBe(true)
  expect(isTrustedRemoteRendererUrl("http://127.0.0.1:5174/settings", "http://127.0.0.1:5173/")).toBe(false)
  expect(isTrustedRemoteRendererUrl("https://attacker.example/", "http://127.0.0.1:5173/")).toBe(false)
})

test("renderer origin policy rejects opaque, blank, malformed, and credentialed URLs", () => {
  expect(isTrustedRemoteRendererUrl("about:blank", "http://127.0.0.1:5173/")).toBe(false)
  expect(isTrustedRemoteRendererUrl("data:text/html,hi", "http://127.0.0.1:5173/")).toBe(false)
  expect(isTrustedRemoteRendererUrl("null", "http://127.0.0.1:5173/")).toBe(false)
  expect(isTrustedRemoteRendererUrl("oc://user@renderer/index.html", undefined)).toBe(false)
  expect(isTrustedRemoteRendererUrl(12, undefined)).toBe(false)
})
