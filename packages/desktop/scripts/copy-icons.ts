import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const src = `./icons/${channel}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
await $`cp ./icons/windows/icon.ico ${dest}/windows.ico`
console.log(`Copied transparent Windows icon to ${dest}/windows.ico channel=${channel}`)
const copied = await Array.fromAsync(new Bun.Glob("icon.*").scan({ cwd: dest }))
console.log(`Copied ${channel} icons from ${src} to ${dest} files=${copied.sort().join(",")}`)
