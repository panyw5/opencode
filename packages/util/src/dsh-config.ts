export const DSH_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const DSH_MIN_TIMEOUT_MS = 30 * 1000
export const DSH_MAX_TIMEOUT_MS = 30 * 60 * 1000

/** Defaults for installed DSH consults; explicit per-call fields replace these values. */
export type DshConsultDefaults = {
  profile?: string
  working_directory?: string
  timeout_ms?: number
  patch?: string | string[]
  permission_mode?: string
  approval_policy?: "ask" | "never"
  additional_writable_roots?: string[]
}

/** Refuse requested permissions when the installed profile does not advertise their CLI flags. */
export function assertDshPermissionSupport(help: string, options: DshConsultDefaults): void {
  for (const [flag, requested] of [
    ["--permission-mode", options.permission_mode !== undefined],
    ["--approval-policy", options.approval_policy !== undefined],
    ["--add-dir", (options.additional_writable_roots?.length ?? 0) > 0],
  ] as const) {
    if (requested && !new RegExp(`${flag}(?:[\\s=<,]|$)`).test(help)) {
      throw new Error(
        `The selected DSH profile does not advertise ${flag}. Update the installed dsh CLI or select a compatible headless profile; requested permissions were not applied.`,
      )
    }
  }
}

/** Validate defaults received from desktop storage or configuration JSON. */
export function parseDshConsultDefaults(value: unknown): DshConsultDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid DSH defaults")
  const out: DshConsultDefaults = {}
  for (const key of ["profile", "working_directory", "permission_mode"] as const) {
    if (!(key in value)) continue
    const field = Reflect.get(value, key)
    if (typeof field !== "string" || !field.trim() || field.includes("\0")) {
      throw new Error(`Invalid DSH defaults.${key}`)
    }
    if (key === "profile" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(field)) {
      throw new Error("Invalid DSH defaults.profile")
    }
    out[key] = field
  }
  if ("timeout_ms" in value) {
    const timeout = Reflect.get(value, "timeout_ms")
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < DSH_MIN_TIMEOUT_MS ||
      timeout > DSH_MAX_TIMEOUT_MS
    ) {
      throw new Error("DSH timeout_ms must be an integer between 30000 and 1800000")
    }
    out.timeout_ms = timeout
  }
  if ("approval_policy" in value) {
    const policy = Reflect.get(value, "approval_policy")
    if (policy !== "ask" && policy !== "never") throw new Error("Invalid DSH defaults.approval_policy")
    out.approval_policy = policy
  }
  if ("patch" in value) {
    const patch = Reflect.get(value, "patch")
    if (typeof patch !== "string" && !(Array.isArray(patch) && patch.every((item) => typeof item === "string"))) {
      throw new Error("Invalid DSH defaults.patch")
    }
    out.patch = patch
  }
  if ("additional_writable_roots" in value) {
    const roots = Reflect.get(value, "additional_writable_roots")
    if (
      !Array.isArray(roots) ||
      !roots.every((item) => typeof item === "string" && item.trim() && !item.includes("\0"))
    ) {
      throw new Error("Invalid DSH defaults.additional_writable_roots")
    }
    out.additional_writable_roots = roots.slice()
  }
  return out
}
