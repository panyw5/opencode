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
    activation?: string[]
    fileViewers?: Array<Record<string, unknown>>
    webExport?: unknown
  } = {},
) {
  const root = path.join(dir, input.id?.replaceAll(".", "-") ?? "extension")
  const entry = input.entry ?? "dist/web/index.js"
  await mkdir(path.dirname(path.join(root, entry)), { recursive: true })
  await Bun.write(path.join(root, entry), "export default {}\n")
  for (const style of input.styles ?? []) {
    await mkdir(path.dirname(path.join(root, style)), { recursive: true })
    await Bun.write(path.join(root, style), ".test {}\n")
  }
  if (input.icon) {
    await mkdir(path.dirname(path.join(root, input.icon)), { recursive: true })
    await Bun.write(path.join(root, input.icon), "icon")
  }
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: input.name ?? "test-extension",
        version: input.version ?? "1.2.3",
        ...(input.engines ? { engines: { opencode: input.engines } } : {}),
        exports: {
          "./web": input.webExport ?? `./${entry}`,
        },
        opencode: {
          manifestVersion: 1,
          id: input.id ?? "test.extension",
          displayName: "Test Extension",
          ...(input.icon ? { icon: `./${input.icon}` } : {}),
          web: { apiVersion: 1, styles: (input.styles ?? []).map((x) => `./${x}`) },
          activation: input.activation ?? ["onFileViewer:hello"],
          contributes: {
            fileViewers: input.fileViewers ?? [{ id: "hello", title: "Hello", extensions: ["hello"], mode: "replace" }],
          },
        },
      },
      null,
      2,
    ),
  )
  return root
}
