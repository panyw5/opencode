const { app } = require("electron")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

// Isolated supervisor probe: never imports the product main, server or persisted user settings.
function argument(name) {
  const prefix = `--probe-${name}=`
  const value = process.argv.find((value) => value.startsWith(prefix))
  if (!value) throw new Error(`Missing supervisor probe argument: ${name}`)
  return value.slice(prefix.length)
}
const root = argument("root")
app.setPath("userData", path.join(root, "electron-user-data"))
app.setAppLogsPath(path.join(root, "electron-logs"))
app.disableHardwareAcceleration()
app
  .whenReady()
  .then(() => import(pathToFileURL(argument("runner")).href))
  .catch((error) => {
    process.stderr.write(`extension supervisor probe failed: ${error.message}\n`)
    app.exit(1)
  })
