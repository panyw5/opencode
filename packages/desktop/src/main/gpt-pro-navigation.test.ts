import { expect, test } from "bun:test"
import { GptProNavigationGuard } from "./gpt-pro-navigation"

const home = "https://chatgpt.com/"
const login = "https://chatgpt.com/auth/login?next=%2F"

test("bounds same-URL login reloads while leaving duplicate committed events alone", () => {
  const guard = new GptProNavigationGuard()
  expect(Array.from({ length: 5 }, (_, i) => guard.request(login, i * 100))).toEqual([true, true, true, true, false])
  guard.reset()
  expect(guard.request(login, 1000)).toBe(true)
})

test("stops repeated home/login navigation, without changing cookies or submitting", () => {
  const guard = new GptProNavigationGuard()
  expect([home, login, home, login, home].map((url, i) => guard.allow(url, i * 100))).toEqual([
    true,
    true,
    true,
    true,
    false,
  ])
  expect(guard.blocked).toBe(true)
  expect(guard.allow(login, 1000)).toBe(false)
  guard.reset()
  expect(guard.allow(home, 1100)).toBe(true)
})

test("does not count duplicate events or normal spaced-out visits as a redirect loop", () => {
  const guard = new GptProNavigationGuard()
  for (let i = 0; i < 12; i++) expect(guard.allow(home, i * 100)).toBe(true)
  for (let i = 0; i < 12; i++) expect(guard.allow(i % 2 ? home : login, 20000 + i * 16000)).toBe(true)
})

test("leaves conversation, external authentication, and non-ChatGPT pages alone", () => {
  const guard = new GptProNavigationGuard()
  for (const destination of [
    "https://chatgpt.com/c/conversation",
    "https://auth.openai.com/login",
    "https://example.com/",
    "https://chatgpt.com.example.com/auth/login",
  ]) {
    for (let i = 0; i < 10; i++) {
      expect(guard.allow(home, i * 100)).toBe(true)
      expect(guard.allow(destination, i * 100 + 50)).toBe(true)
    }
  }
})
