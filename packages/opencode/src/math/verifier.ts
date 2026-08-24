export type VerifyResult = {
  verdict: "correct" | "wrong"
  repair_hints?: string
  verification_report?: unknown
}

export type Verifier = {
  verify(input: { statement: string; proof: string }): Promise<VerifyResult>
}

export class VerifyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VerifyUnavailableError"
  }
}

/** Wave 1 test double. Production Wave 1 uses `missingVerifier` unless a URL is set. */
export function stubVerifier(
  impl: (input: { statement: string; proof: string }) => VerifyResult | Promise<VerifyResult>,
): Verifier {
  return { verify: (input) => Promise.resolve(impl(input)) }
}

export function missingVerifier(message = "verifier is not configured"): Verifier {
  return {
    verify: async () => {
      throw new VerifyUnavailableError(message)
    },
  }
}

export function httpVerifier(url: string, timeoutMs = 3_600_000): Verifier {
  return {
    async verify(input) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ statement: input.statement, proof: input.proof }),
          signal: ac.signal,
        })
        if (!res.ok) throw new VerifyUnavailableError(`verify service HTTP ${res.status}`)
        const body: unknown = await res.json()
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new VerifyUnavailableError(`verify service returned a non-dict body (${typeof body})`)
        }
        const rec = body as Record<string, unknown>
        if (rec.verdict !== "correct" && rec.verdict !== "wrong") {
          throw new VerifyUnavailableError(`verify service returned invalid verdict: ${String(rec.verdict)}`)
        }
        return {
          verdict: rec.verdict,
          repair_hints: typeof rec.repair_hints === "string" ? rec.repair_hints : undefined,
          verification_report: rec.verification_report,
        }
      } catch (e) {
        if (e instanceof VerifyUnavailableError) throw e
        const msg = e instanceof Error ? e.message : String(e)
        throw new VerifyUnavailableError(msg)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export * as MathVerifier from "./verifier"
