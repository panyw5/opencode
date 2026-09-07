import { onCleanup, onMount } from "solid-js"

export type ComponentMountFields = {
  name: string
  session?: string
  workspace?: string
  surface?: string
}

type ComponentMountRecord = ComponentMountFields & {
  instance: number
  mountedAt: number
}

export type ComponentMountSnapshot = Record<
  string,
  { active: number; mounts: number; unmounts: number; instances: ComponentMountRecord[] }
>

export function createComponentMountRegistry(write: (line: string) => void = console.debug) {
  let sequence = 0
  const active = new Map<number, ComponentMountRecord>()
  const totals = new Map<string, { mounts: number; unmounts: number }>()

  const snapshot = (): ComponentMountSnapshot => {
    const result: ComponentMountSnapshot = {}
    const names = new Set([...totals.keys(), ...[...active.values()].map((item) => item.name)])
    for (const name of names) {
      const total = totals.get(name) ?? { mounts: 0, unmounts: 0 }
      const instances = [...active.values()].filter((item) => item.name === name)
      result[name] = { active: instances.length, mounts: total.mounts, unmounts: total.unmounts, instances }
    }
    return result
  }

  const mount = (fields: ComponentMountFields) => {
    const record = { ...fields, instance: ++sequence, mountedAt: performance.now() }
    active.set(record.instance, record)
    const total = totals.get(fields.name) ?? { mounts: 0, unmounts: 0 }
    total.mounts += 1
    totals.set(fields.name, total)
    write(
      `[component-mount] event=mount name=${fields.name} instance=${String(record.instance)} session=${fields.session ?? "none"} workspace=${fields.workspace ?? "none"} surface=${fields.surface ?? "none"} active=${String(snapshot()[fields.name]?.active ?? 0)}`,
    )
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      active.delete(record.instance)
      total.unmounts += 1
      write(
        `[component-mount] event=unmount name=${fields.name} instance=${String(record.instance)} lifetime_ms=${String(Math.round(performance.now() - record.mountedAt))} active=${String(snapshot()[fields.name]?.active ?? 0)}`,
      )
    }
  }

  return { mount, snapshot }
}

type ProfileWindow = Window & {
  __opencodeComponentMountProfile?: ReturnType<typeof createComponentMountRegistry>
}

function browserRegistry() {
  if (typeof window === "undefined") return
  const target = window as ProfileWindow
  return (target.__opencodeComponentMountProfile ??= createComponentMountRegistry())
}

export function useComponentMountProfile(fields: () => ComponentMountFields) {
  if (!import.meta.env.DEV) return
  let dispose: (() => void) | undefined
  onMount(() => {
    dispose = browserRegistry()?.mount(fields())
  })
  onCleanup(() => dispose?.())
}

export function ComponentMountProfile(props: ComponentMountFields) {
  useComponentMountProfile(() => props)
  return null
}
