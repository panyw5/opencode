import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { selfArgv } from "./spawn"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "math.verifier" })

export type VerifyInput = {
  problem_id: string
  statement: string
  proof: string
  predecessors: string[]
  predecessor_facts: Array<{ fact_id: string; content: string }>
  glossary: Record<string, string>
}

export type VerificationReport = {
  summary: string
  critical_errors: string[]
  gaps: string[]
}

export type VerifyResult = {
  verdict: "correct" | "wrong"
  repair_hints?: string
  verification_report: VerificationReport
}

export type Verifier = {
  verify(input: VerifyInput): Promise<VerifyResult>
}

export class VerifyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VerifyUnavailableError"
  }
}

/** Wave 1 test double. Production Wave 1 uses `missingVerifier` unless a URL is set. */
export function stubVerifier(
  impl: (
    input: VerifyInput,
  ) =>
    | (Omit<VerifyResult, "verification_report"> & { verification_report?: VerificationReport })
    | Promise<Omit<VerifyResult, "verification_report"> & { verification_report?: VerificationReport }>,
): Verifier {
  return {
    async verify(input) {
      const result = await impl(input)
      return {
        ...result,
        verification_report: result.verification_report ?? {
          summary: "test verifier",
          critical_errors: result.verdict === "wrong" ? [result.repair_hints ?? "rejected by test verifier"] : [],
          gaps: [],
        },
      }
    },
  }
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
          body: JSON.stringify(input),
          signal: ac.signal,
        })
        if (!res.ok) throw new VerifyUnavailableError(`verify service HTTP ${res.status}`)
        const body: unknown = await res.json()
        return decodeVerifyResult(body)
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

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new VerifyUnavailableError(`verify service returned invalid ${field}`)
  }
  return value
}

/** Strict write-gate decoder. A verdict inconsistent with its error/gap lists is rejected. */
export function decodeVerifyResult(body: unknown): VerifyResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VerifyUnavailableError(`verify service returned a non-dict body (${typeof body})`)
  }
  const rec = body as Record<string, unknown>
  if (rec.verdict !== "correct" && rec.verdict !== "wrong") {
    throw new VerifyUnavailableError(`verify service returned invalid verdict: ${String(rec.verdict)}`)
  }
  const rawReport = rec.verification_report
  if (!rawReport || typeof rawReport !== "object" || Array.isArray(rawReport)) {
    throw new VerifyUnavailableError("verify service returned invalid verification_report")
  }
  const report = rawReport as Record<string, unknown>
  if (typeof report.summary !== "string") {
    throw new VerifyUnavailableError("verify service returned invalid verification_report.summary")
  }
  const critical_errors = stringList(report.critical_errors, "verification_report.critical_errors")
  const gaps = stringList(report.gaps, "verification_report.gaps")
  const expected = critical_errors.length === 0 && gaps.length === 0 ? "correct" : "wrong"
  if (rec.verdict !== expected) {
    throw new VerifyUnavailableError(
      `verify verdict inconsistent with report: verdict=${rec.verdict}, expected=${expected}`,
    )
  }
  return {
    verdict: rec.verdict,
    repair_hints: typeof rec.repair_hints === "string" ? rec.repair_hints : undefined,
    verification_report: { summary: report.summary, critical_errors, gaps },
  }
}

export const VERIFIER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["correct", "wrong"] },
    repair_hints: { type: "string" },
    verification_report: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        critical_errors: { type: "array", items: { type: "string" } },
        gaps: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "critical_errors", "gaps"],
    },
  },
  required: ["verdict", "verification_report"],
} as const

export function buildVerifierPrompt(input: VerifyInput): string {
  return [
    "You are a cold-start mathematical proof verifier. Judge only the supplied claim, proof, verified predecessor facts, and glossary.",
    "A claim is correct if and only if there are zero critical errors and zero logical gaps. Do not repair, complete, or charitably reinterpret the proof.",
    "Check every inference in order, all quantifiers and boundary cases, every cited predecessor, and every introduced symbol.",
    "Set verdict=correct exactly when verification_report.critical_errors and verification_report.gaps are both empty; otherwise set verdict=wrong and provide actionable repair_hints.",
    "Return only one JSON object matching this schema. Do not use Markdown fences or add prose outside the JSON.",
    JSON.stringify(VERIFIER_OUTPUT_SCHEMA),
    "",
    JSON.stringify(input, null, 2),
  ].join("\n")
}

export function parseVerifierText(text: string): VerifyResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new VerifyUnavailableError("math verifier did not return a bare JSON object")
  }
  try {
    return decodeVerifyResult(JSON.parse(trimmed))
  } catch (error) {
    if (error instanceof VerifyUnavailableError) throw error
    throw new VerifyUnavailableError(
      `math verifier returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

type ProcessVerifierOptions = {
  workspace: string
  model?: string
  timeoutMs?: number
  run?: (inputFile: string) => Promise<string>
}

/**
 * The CLI writes its verdict as one compact JSON line. Other runtime diagnostics
 * may reach stdout before that frame, especially inside the Electron sidecar.
 */
export function extractVerifierProcessOutput(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const framed = lines.toReversed().find((line) => line.startsWith("{") && line.endsWith("}"))
  if (!framed) throw new VerifyUnavailableError("math verifier process returned no bare JSON frame")
  return framed
}

async function runVerifyProcess(
  workspace: string,
  inputFile: string,
  timeoutMs: number,
  model?: string,
): Promise<string> {
  const argv = selfArgv([
    "math",
    "verify",
    "--input",
    inputFile,
    "--dir",
    workspace,
    ...(model ? ["--model", model] : []),
  ])
  return new Promise((resolve, reject) => {
    log.info("math verifier process spawning", {
      executable: argv[0],
      cwd: workspace,
      timeoutMs,
      model,
    })
    const child = spawn(argv[0], argv.slice(1), { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      log.error("math verifier process spawn error", { executable: argv[0], error: error.message })
      reject(error)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      log.info("math verifier process exited", {
        code,
        signal,
        stdoutLines: stdout.split(/\r?\n/).filter(Boolean).length,
        stderrLines: stderr.split(/\r?\n/).filter(Boolean).length,
      })
      if (code !== 0) {
        reject(new Error(`math verifier exited code=${code} signal=${signal ?? "none"}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(extractVerifierProcessOutput(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })
}

/** Production verifier: each claim is judged in a fresh OpenCode CLI process/session. */
export function sessionVerifier(options: ProcessVerifierOptions): Verifier {
  return {
    async verify(input) {
      log.info("math verifier confined to problem workspace", {
        problemID: input.problem_id,
        workspace: options.workspace,
      })
      const root = await mkdtemp(path.join(tmpdir(), "opencode-math-verify-"))
      const inputFile = path.join(root, "input.json")
      try {
        await mkdir(root, { recursive: true })
        await writeFile(inputFile, JSON.stringify(input), "utf8")
        const raw = options.run
          ? await options.run(inputFile)
          : await runVerifyProcess(options.workspace, inputFile, options.timeoutMs ?? 3_600_000, options.model)
        return parseVerifierText(raw)
      } catch (error) {
        if (error instanceof VerifyUnavailableError) throw error
        const message = error instanceof Error ? error.message : String(error)
        throw new VerifyUnavailableError(message)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

export async function readVerifyInput(file: string): Promise<VerifyInput> {
  const body: unknown = JSON.parse(await readFile(file, "utf8"))
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("verify input must be an object")
  const rec = body as Record<string, unknown>
  if (typeof rec.problem_id !== "string" || typeof rec.statement !== "string" || typeof rec.proof !== "string") {
    throw new Error("verify input requires problem_id, statement, and proof")
  }
  if (!Array.isArray(rec.predecessors) || rec.predecessors.some((item) => typeof item !== "string")) {
    throw new Error("verify input predecessors must be strings")
  }
  if (!Array.isArray(rec.predecessor_facts)) throw new Error("verify input predecessor_facts must be an array")
  const predecessor_facts = rec.predecessor_facts.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid predecessor fact")
    const fact = item as Record<string, unknown>
    if (typeof fact.fact_id !== "string" || typeof fact.content !== "string")
      throw new Error("invalid predecessor fact")
    return { fact_id: fact.fact_id, content: fact.content }
  })
  if (!rec.glossary || typeof rec.glossary !== "object" || Array.isArray(rec.glossary)) {
    throw new Error("verify input glossary must be an object")
  }
  const glossary: Record<string, string> = {}
  for (const [key, value] of Object.entries(rec.glossary as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`verify input glossary.${key} must be a string`)
    glossary[key] = value
  }
  return {
    problem_id: rec.problem_id,
    statement: rec.statement,
    proof: rec.proof,
    predecessors: rec.predecessors as string[],
    predecessor_facts,
    glossary,
  }
}

export * as MathVerifier from "./verifier"
