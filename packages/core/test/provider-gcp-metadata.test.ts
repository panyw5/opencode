import { createRequire } from "module"
import { describe, expect, test } from "bun:test"

describe("gcp-metadata availability contracts", () => {
  test("treats dual-host AggregateError as a silent non-GCP result", async () => {
    const require = createRequire(import.meta.url)
    const authPackage = require.resolve("google-auth-library/package.json")
    const env: Record<string, string | undefined> = {
      ...process.env,
      METADATA_SERVER_DETECTION: "ping-only",
      DETECT_GCP_RETRIES: "0",
    }
    delete env.DEBUG_AUTH
    delete env.GCE_METADATA_HOST
    delete env.GCE_METADATA_IP

    const script = String.raw`
      const { createRequire } = require("module")
      const anchored = createRequire(process.env.AUTH_PACKAGE)
      const gaxios = anchored("gaxios")
      const calls = []
      gaxios.request = async (options) => {
        calls.push(String(options.url))
        const error = new Error("fixture metadata endpoint unavailable")
        error.code = "ECONNREFUSED"
        throw error
      }
      const metadata = anchored("gcp-metadata")
      metadata.resetIsAvailableCache()
      const warnings = []
      const emitWarning = process.emitWarning
      process.emitWarning = (...args) => warnings.push(args.map(String))
      try {
        const available = await metadata.isAvailable()
        process.stdout.write(JSON.stringify({ available, calls, warnings }))
      } finally {
        process.emitWarning = emitWarning
        metadata.resetIsAvailableCache()
      }
    `
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...env, AUTH_PACKAGE: authPackage },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    const result = JSON.parse(stdout) as { available: boolean; calls: string[]; warnings: string[][] }
    expect(result.available).toBe(false)
    expect(result.calls).toHaveLength(2)
    expect(result.calls[0]).toContain("169.254.169.254")
    expect(result.calls[1]).toContain("metadata.google.internal")
    expect(result.warnings).toEqual([])
  })
})
