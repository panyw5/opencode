import path from "node:path"
import { Effect, Schema } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Extension } from "@/extension"
import { ExtensionID, type Info } from "@/extension/schema"
import { errorMessage } from "@/util/error"

function extensionID(value: unknown) {
  return Schema.decodeUnknownSync(ExtensionID)(String(value ?? "").trim())
}

function orFail<A>(effect: Effect.Effect<A, Error>) {
  return effect.pipe(Effect.catch((error) => fail(errorMessage(error))))
}

export function formatExtensionList(items: Info[]) {
  return items
    .map((item) => {
      const source = item.source.type === "path" ? item.source.path : ""
      return `${item.id}\t${item.version}\t${item.state}\t${source}`
    })
    .join("\n")
}

const LinkCommand = effectCmd({
  command: "link <directory>",
  describe: "link a local extension directory",
  instance: false,
  builder: (yargs) =>
    yargs.positional("directory", {
      type: "string",
      demandOption: true,
      describe: "extension package directory",
    }),
  handler: Effect.fn("Cli.extension.link")(function* (args) {
    const directory = path.resolve(String(args.directory))
    const extension = yield* Extension.Service
    const item = yield* orFail(extension.link(directory))
    UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}Linked${UI.Style.TEXT_NORMAL} ${item.id}@${item.version}`)
  }),
})

const ListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list linked extensions",
  instance: false,
  builder: (yargs) =>
    yargs.option("json", {
      type: "boolean",
      default: false,
      describe: "print JSON",
    }),
  handler: Effect.fn("Cli.extension.list")(function* (args) {
    const extension = yield* Extension.Service
    const items = yield* orFail(extension.list())
    if (args.json) {
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`)
      return
    }
    if (!items.length) {
      UI.println("No linked extensions")
      return
    }
    UI.println(formatExtensionList(items))
  }),
})

function setEnabledCommand(enabled: boolean) {
  return effectCmd({
    command: `${enabled ? "enable" : "disable"} <id>`,
    describe: `${enabled ? "enable" : "disable"} a linked extension`,
    instance: false,
    builder: (yargs) =>
      yargs.positional("id", {
        type: "string",
        demandOption: true,
        describe: "extension id",
      }),
    handler: Effect.fn(`Cli.extension.${enabled ? "enable" : "disable"}`)(function* (args) {
      let id: ExtensionID
      try {
        id = extensionID(args.id)
      } catch {
        return yield* fail(`Invalid extension id: ${String(args.id ?? "")}`)
      }
      const extension = yield* Extension.Service
      const item = yield* orFail(extension.setEnabled(id, enabled))
      UI.println(
        `${enabled ? UI.Style.TEXT_SUCCESS_BOLD : UI.Style.TEXT_DIM_BOLD}${enabled ? "Enabled" : "Disabled"}${UI.Style.TEXT_NORMAL} ${item.id}`,
      )
    }),
  })
}

export const ExtensionCommand = cmd({
  command: "extension",
  aliases: ["ext"],
  describe: "manage OpenCode extensions",
  builder: (yargs) =>
    yargs
      .command(LinkCommand)
      .command(ListCommand)
      .command(setEnabledCommand(true))
      .command(setEnabledCommand(false))
      .demandCommand(),
  async handler() {},
})
