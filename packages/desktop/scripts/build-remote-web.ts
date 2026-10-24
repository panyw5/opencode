#!/usr/bin/env bun
import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const appDir = path.resolve(desktopDir, "../app")
const remoteWebDir = path.resolve(desktopDir, "resources/remote-web")
console.log(`[desktop] building remote web assets output=${remoteWebDir}`)
await $`bun run build -- --outDir ${remoteWebDir} --emptyOutDir --sourcemap false`
  .cwd(appDir)
  .env({ ...Bun.env, VITE_OPENCODE_REMOTE: "true", SENTRY_AUTH_TOKEN: "" })
