import { describe, expect, test } from "bun:test"
import {
  createLocalInstallationOperations,
  digestMatches,
  registerArchiveDropHandler,
  takeArchiveDrop,
} from "./install-local"
import type { InstallationRequest } from "../pages/install-actions-state"

describe("digestMatches", () => {
  test("accepts case-insensitive exact matches with trimmed whitespace", () => {
    const digest = "a".repeat(64)
    expect(digestMatches(` ${digest.toUpperCase()} `, digest)).toBe(true)
  })

  test("rejects partial digests, non-hex input and real mismatches", () => {
    const digest = "a".repeat(64)
    expect(digestMatches(digest.slice(0, 63), digest)).toBe(false)
    expect(digestMatches(digest, "b".repeat(64))).toBe(false)
    expect(digestMatches("z".repeat(64), digest)).toBe(false)
    expect(digestMatches("", digest)).toBe(false)
  })
})

describe("createLocalInstallationOperations", () => {
  const request: InstallationRequest = {
    kind: "install",
    source: { type: "local", path: "/tmp/demo.tgz", sha256: "a".repeat(64) },
  }

  test("prepare forwards the request and unwraps ok responses", async () => {
    const calls: Array<{ op: string; payload: Record<string, unknown> }> = []
    const operations = createLocalInstallationOperations(async (op, payload) => {
      calls.push({ op, payload })
      return { ok: true, value: { operationId: "op-1", token: "tok-1", kind: "install" } }
    })
    const prepared = await operations.prepareInstallation(request)
    expect(prepared).toMatchObject({ operationId: "op-1" })
    expect(calls[0]).toMatchObject({ op: "prepare" })
    const sent = calls[0]!.payload.request as { source: { type: string } }
    expect(sent.source).toMatchObject({ type: "local" })
  })

  test("commit maps enable and registry upgrade flags", async () => {
    const calls: Array<{ op: string; payload: Record<string, unknown> }> = []
    const operations = createLocalInstallationOperations(async (op, payload) => {
      calls.push({ op, payload })
      return { ok: true, value: { state: "committed" } }
    })
    await operations.commitInstallation({ operationId: "op-1", token: "tok-1" } as never, {
      enable: true,
      acceptRegistryUpgrade: true,
    })
    expect(calls[0]).toMatchObject({
      op: "commit",
      payload: {
        operationId: "op-1",
        token: "tok-1",
        input: { enable: true, acceptRegistryUpgrade: true },
      },
    })
  })

  test("error responses reject with code-carrying errors", async () => {
    const operations = createLocalInstallationOperations(async () => ({
      ok: false,
      error: { code: "integrity", message: "digest mismatch" },
    }))
    await expect(operations.prepareInstallation(request)).rejects.toMatchObject({
      code: "integrity",
      message: "digest mismatch",
    })
  })
})

describe("archive drop registry", () => {
  test("consumer receives all-tgz drops until unregistered", () => {
    let received: string[] | undefined
    const unregister = registerArchiveDropHandler((paths) => {
      received = paths
      return paths.length > 0
    })
    expect(takeArchiveDrop(["/tmp/a.tgz", "/tmp/b.TGZ"])).toBe(true)
    expect(received).toEqual(["/tmp/a.tgz", "/tmp/b.TGZ"])
    unregister()
    received = undefined
    expect(takeArchiveDrop(["/tmp/a.tgz"])).toBe(false)
    expect(received).toBeUndefined()
  })

  test("handler returning false lets the drop fall through", () => {
    const unregister = registerArchiveDropHandler(() => false)
    expect(takeArchiveDrop(["/tmp/a.tgz"])).toBe(false)
    unregister()
  })

  test("a newer consumer replaces the previous one", () => {
    const first = registerArchiveDropHandler(() => true)
    const second = registerArchiveDropHandler(() => true)
    expect(takeArchiveDrop(["/tmp/a.tgz"])).toBe(true)
    first()
    expect(takeArchiveDrop(["/tmp/a.tgz"])).toBe(true)
    second()
    expect(takeArchiveDrop(["/tmp/a.tgz"])).toBe(false)
  })
})
