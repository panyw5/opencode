import { Index, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { DirectoryInput } from "./directory-input"
import { useLanguage } from "@/context/language"
import { dshChoiceValues, type DshDefaultsForm } from "@/pages/config-dsh-defaults"

function DshChoice(props: {
  label: string
  description: string
  options: { value: string; label: string }[]
  current: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <span class="text-12-medium text-text-weak">{props.label}</span>
      <Select
        options={props.options}
        current={props.options.find((option) => option.value === props.current)}
        value={(option) => "value:" + option.value}
        label={(option) => option.label}
        onSelect={(option) => {
          if (!option || option.value === props.current) return
          console.debug("[dsh-defaults] selection changed field=" + props.label)
          props.onChange(option.value)
        }}
        disabled={props.disabled}
        variant="secondary"
        size="large"
        triggerClass="w-full min-w-0 justify-between"
        triggerProps={{ "aria-label": props.label }}
      />
      <p class="text-12-regular text-text-weak">{props.description}</p>
    </div>
  )
}

export function DshDefaultsEditor(props: {
  form: DshDefaultsForm
  disabled: boolean
  profiles?: string[]
  onChange: (value: DshDefaultsForm) => void
}) {
  const language = useLanguage()
  const change = <K extends keyof DshDefaultsForm>(key: K, value: DshDefaultsForm[K]) =>
    props.onChange({ ...props.form, [key]: value })
  const policies = () => [
    { value: "", label: language.t("config.claws.dsh.defaults.inherit") },
    { value: "ask", label: language.t("config.claws.dsh.defaults.ask") },
    { value: "never", label: language.t("config.claws.dsh.defaults.never") },
  ]
  const profiles = () =>
    dshChoiceValues(["", "headless", ...(props.profiles ?? [])], props.form.profile).map((value) => ({
      value,
      label: value || language.t("config.claws.dsh.defaults.defaultProfile"),
    }))
  const timeouts = () =>
    dshChoiceValues(["", "30", "60", "120", "300", "600", "900", "1200", "1800"], props.form.timeoutSeconds).map(
      (value) => ({
        value,
        label:
          value === ""
            ? language.t("config.claws.dsh.defaults.defaultTimeout")
            : Number(value) % 60 === 0
              ? language.t("config.claws.dsh.defaults.timeoutMinutes", { minutes: Number(value) / 60 })
              : language.t("config.claws.dsh.defaults.timeoutSeconds", { seconds: value }),
      }),
    )
  const permissions = () =>
    dshChoiceValues(["", "read-only", "workspace-write", "danger-full-access"], props.form.permissionMode).map(
      (value) => ({
        value,
        label:
          value === ""
            ? language.t("config.claws.dsh.defaults.inherit")
            : value === "read-only"
              ? language.t("config.claws.dsh.defaults.readOnly")
              : value === "workspace-write"
                ? language.t("config.claws.dsh.defaults.workspaceWrite")
                : value === "danger-full-access"
                  ? language.t("config.claws.dsh.defaults.fullAccess")
                  : value,
      }),
    )
  return (
    <section class="rounded-2xl border border-border-weak-base bg-surface-base p-4" data-testid="dsh-defaults">
      <h3 class="text-13-medium text-text-strong">{language.t("config.claws.dsh.defaults.title")}</h3>
      <p class="mt-1 text-12-regular text-text-weak">{language.t("config.claws.dsh.defaults.description")}</p>
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <DshChoice
          label={language.t("config.claws.dsh.defaults.profile")}
          description={language.t("config.claws.dsh.defaults.profileHint")}
          options={profiles()}
          current={props.form.profile}
          disabled={props.disabled}
          onChange={(value) => change("profile", value)}
        />
        <DshChoice
          label={language.t("config.claws.dsh.defaults.timeout")}
          description={language.t("config.claws.dsh.defaults.timeoutHint")}
          options={timeouts()}
          current={props.form.timeoutSeconds}
          disabled={props.disabled}
          onChange={(value) => change("timeoutSeconds", value)}
        />
        <DirectoryInput
          label={language.t("config.claws.dsh.defaults.directory")}
          description={language.t("config.claws.dsh.defaults.directoryHint")}
          value={props.form.workingDirectory}
          absolute
          disabled={props.disabled}
          onChange={(value) => change("workingDirectory", value)}
        />
        <DshChoice
          label={language.t("config.claws.dsh.defaults.permission")}
          description={language.t("config.claws.dsh.defaults.permissionHint")}
          options={permissions()}
          current={props.form.permissionMode}
          disabled={props.disabled}
          onChange={(value) => change("permissionMode", value)}
        />
        <DshChoice
          label={language.t("config.claws.dsh.defaults.approval")}
          description={language.t("config.claws.dsh.defaults.approvalHint")}
          options={policies()}
          current={props.form.approvalPolicy}
          disabled={props.disabled}
          onChange={(value) => change("approvalPolicy", value)}
        />
        <div class="min-w-0 space-y-2" data-component="directory-list">
          <div class="text-12-medium text-text-base">{language.t("config.claws.dsh.defaults.roots")}</div>
          <p class="text-12-regular text-text-weak">{language.t("config.claws.dsh.defaults.rootsHint")}</p>
          <Index each={props.form.additionalWritableRoots.split(/\r?\n/)}>
            {(value, index) => (
              <div class="flex min-w-0 items-start gap-2">
                <DirectoryInput
                  label={language.t("directoryInput.entry", {
                    label: language.t("config.claws.dsh.defaults.roots"),
                    index: index + 1,
                  })}
                  hideLabel
                  absolute
                  value={value()}
                  disabled={props.disabled}
                  onChange={(next) =>
                    change(
                      "additionalWritableRoots",
                      props.form.additionalWritableRoots
                        .split(/\r?\n/)
                        .map((item, i) => (i === index ? next : item))
                        .join("\n"),
                    )
                  }
                />
                <Button
                  size="large"
                  variant="ghost"
                  icon="close"
                  class="!h-11 shrink-0"
                  disabled={props.disabled || !props.form.additionalWritableRoots}
                  aria-label={language.t("directoryInput.remove")}
                  onClick={() =>
                    change(
                      "additionalWritableRoots",
                      props.form.additionalWritableRoots
                        .split(/\r?\n/)
                        .filter((_, i) => i !== index)
                        .join("\n"),
                    )
                  }
                />
              </div>
            )}
          </Index>
          <Button
            size="small"
            variant="secondary"
            disabled={props.disabled}
            onClick={() => change("additionalWritableRoots", props.form.additionalWritableRoots + "\n")}
          >
            {language.t("directoryInput.add")}
          </Button>
        </div>
      </div>
      <Show when={props.form.permissionMode.trim() === "danger-full-access"}>
        <p role="note" class="mt-3 text-12-regular text-text-strong">
          {language.t("config.claws.dsh.defaults.fullAccessWarning")}
        </p>
      </Show>
      <div class="mt-4 space-y-3">
        <p class="text-12-regular text-text-weak">{language.t("config.claws.dsh.defaults.patchHint")}</p>
        <Index each={props.form.patches}>
          {(patch, index) => (
            <div class="space-y-2">
              <TextField
                label={language.t("config.claws.dsh.defaults.patch", { index: index + 1 })}
                multiline
                rows={5}
                value={patch()}
                disabled={props.disabled}
                onChange={(value) =>
                  change(
                    "patches",
                    props.form.patches.map((item, i) => (i === index ? value : item)),
                  )
                }
              />
              <Button
                size="small"
                variant="ghost"
                disabled={props.disabled}
                onClick={() =>
                  change(
                    "patches",
                    props.form.patches.filter((_, i) => i !== index),
                  )
                }
              >
                {language.t("config.claws.dsh.defaults.removePatch")}
              </Button>
            </div>
          )}
        </Index>
        <Button
          size="small"
          variant="secondary"
          disabled={props.disabled}
          onClick={() => change("patches", [...props.form.patches, ""])}
        >
          {language.t("config.claws.dsh.defaults.addPatch")}
        </Button>
      </div>
    </section>
  )
}
