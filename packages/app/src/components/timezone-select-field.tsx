import { Select } from "@opencode-ai/ui/select"
import { createMemo, type JSX } from "solid-js"
import { timeZoneGroup, timeZoneOptions } from "@/utils/timezones"

export function TimezoneSelectField(props: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  const options = createMemo(() => timeZoneOptions(props.value))
  const current = createMemo(() => {
    const value = props.value
    return options().includes(value) ? value : options()[0]
  })

  return (
    <label class="block min-w-0">
      <span class="mb-1 block text-12-medium text-text-weak">{props.label}</span>
      <Select
        options={options()}
        current={current()}
        groupBy={timeZoneGroup}
        onSelect={(item) => item && props.onChange(item)}
        class="w-full"
      />
    </label>
  )
}
