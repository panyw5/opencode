import { parseDshConsultDefaults, type DshConsultDefaults } from "@opencode-ai/util/dsh-config"

export function dshDefaultsForm(input?: DshConsultDefaults) {
  return {
    profile: input?.profile ?? "",
    workingDirectory: input?.working_directory ?? "",
    timeoutSeconds: input?.timeout_ms === undefined ? "" : String(input.timeout_ms / 1000),
    patches: typeof input?.patch === "string" ? [input.patch] : [...(input?.patch ?? [])],
    permissionMode: input?.permission_mode ?? "",
    approvalPolicy: input?.approval_policy ?? "",
    additionalWritableRoots: input?.additional_writable_roots?.join("\n") ?? "",
  }
}

export type DshDefaultsForm = ReturnType<typeof dshDefaultsForm>

/** Preserve configured custom values alongside the standard selectable options. */
export function dshChoiceValues(standard: readonly string[], current: string): string[] {
  return [...new Set([...standard, current])]
}

export function dshDefaultsInput(form: DshDefaultsForm): DshConsultDefaults {
  const roots = form.additionalWritableRoots
    .split(/\r?\n/)
    .map((root) => root.trim())
    .filter(Boolean)
  return parseDshConsultDefaults({
    ...(form.profile.trim() ? { profile: form.profile.trim() } : {}),
    ...(form.workingDirectory.trim() ? { working_directory: form.workingDirectory.trim() } : {}),
    ...(form.timeoutSeconds.trim() ? { timeout_ms: Number(form.timeoutSeconds) * 1000 } : {}),
    ...(form.patches.length ? { patch: form.patches.filter((patch) => patch.trim()) } : {}),
    ...(form.permissionMode.trim() ? { permission_mode: form.permissionMode.trim() } : {}),
    ...(form.approvalPolicy ? { approval_policy: form.approvalPolicy } : {}),
    ...(roots.length ? { additional_writable_roots: [...new Set(roots)] } : {}),
  })
}
