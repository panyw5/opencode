import path from "node:path"
import { mkdir } from "node:fs/promises"

export async function extensionPackage(
  dir: string,
  input: {
    id?: string
    name?: string
    version?: string
    engines?: string
    entry?: string
    styles?: string[]
    icon?: string
    activation?: string[] | null
    fileViewers?: Array<Record<string, unknown>> | null
    toolRenderers?: Array<Record<string, unknown>>
    commands?: Array<Record<string, unknown>>
    panels?: Array<Record<string, unknown>>
    settings?: Record<string, unknown>
    webExport?: unknown | null
    serverEntry?: string
    serverExport?: unknown | null
    webManifest?: boolean
  } = {},
) {
  const root = path.join(dir, input.id?.replaceAll(".", "-") ?? "extension")
  const entry = input.entry ?? "dist/web/index.js"
  if (input.webExport !== null) {
    await mkdir(path.dirname(path.join(root, entry)), { recursive: true })
    await Bun.write(path.join(root, entry), "export default {}\n")
  }
  if (input.serverEntry) {
    await mkdir(path.dirname(path.join(root, input.serverEntry)), { recursive: true })
    await Bun.write(path.join(root, input.serverEntry), "export default {}\n")
  }
  for (const style of input.styles ?? []) {
    await mkdir(path.dirname(path.join(root, style)), { recursive: true })
    await Bun.write(path.join(root, style), ".test {}\n")
  }
  if (input.icon) {
    await mkdir(path.dirname(path.join(root, input.icon)), { recursive: true })
    await Bun.write(path.join(root, input.icon), "icon")
  }
  const contributes: Record<string, unknown> = {}
  if (input.fileViewers !== null) {
    contributes.fileViewers =
      input.fileViewers ?? [{ id: "hello", title: "Hello", extensions: ["hello"], mode: "replace" }]
  }
  if (input.toolRenderers) contributes.toolRenderers = input.toolRenderers
  if (input.commands) contributes.commands = input.commands
  if (input.panels) contributes.panels = input.panels
  if (input.settings) contributes.settings = input.settings
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: input.name ?? "test-extension",
        version: input.version ?? "1.2.3",
        ...(input.engines ? { engines: { opencode: input.engines } } : {}),
        exports: {
          ...(input.webExport !== null ? { "./web": input.webExport ?? `./${entry}` } : {}),
          ...(input.serverEntry && input.serverExport !== null
            ? { "./server": input.serverExport ?? `./${input.serverEntry}` }
            : {}),
        },
        opencode: {
          manifestVersion: 1,
          id: input.id ?? "test.extension",
          displayName: "Test Extension",
          ...(input.icon ? { icon: `./${input.icon}` } : {}),
          ...(input.webManifest === false
            ? {}
            : { web: { apiVersion: 1, styles: (input.styles ?? []).map((x) => `./${x}`) } }),
          ...(input.activation === null ? {} : { activation: input.activation ?? ["onFileViewer:hello"] }),
          ...(Object.keys(contributes).length ? { contributes } : {}),
        },
      },
      null,
      2,
    ),
  )
  return root
}
