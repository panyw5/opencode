import type { ExtensionCommandSource } from "./context"

export function createExtensionCommandHandler(input: {
  extensionID: string
  commandID: string
  title: string
  run(source?: ExtensionCommandSource): void | Promise<void>
  toast(input: { variant: "error"; title: string; description: string }): unknown
}) {
  return async (source?: ExtensionCommandSource): Promise<void> => {
    try {
      await input.run(source)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[extension-host] command failed id=${input.extensionID} command=${input.commandID} error=${message}`,
      )
      input.toast({ variant: "error", title: input.title, description: message })
    }
  }
}
