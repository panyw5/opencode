const { app, utilityProcess } = require("electron")
const { createInterface } = require("node:readline")
const path = require("node:path")

// An isolated, windowless test app. Never imports the application main or its user's store.
function argument(name) {
  const prefix = `--probe-${name}=`
  const value = process.argv.find((value) => value.startsWith(prefix))
  if (!value) throw new Error(`Missing probe argument: ${name}`)
  return value.slice(prefix.length)
}

const root = argument("root")
app.setPath("userData", path.join(root, "electron-user-data"))
app.setAppLogsPath(path.join(root, "electron-logs"))
app.disableHardwareAcceleration()
let child
let childPID
let finishing = false
let parentGone = false
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, runtime: "electron" })}\n`)

function stop() {
  parentGone = true
  if (child && !finishing) child.kill()
  else app.exit(1)
}

function fail(error) {
  if (!parentGone) process.stderr.write(`extension ownership probe failed: ${error.message}\n`)
  stop()
}

process.stdout.on("error", stop)
process.stderr.on("error", stop)

app
  .whenReady()
  .then(() => {
    child = utilityProcess.fork(argument("worker"), [argument("file"), argument("mode")], {
      stdio: "pipe",
      cwd: root,
      serviceName: "extension lifecycle ownership probe",
    })
    child.once("spawn", () => {
      childPID = child.pid
      process.stderr.write(`extension ownership utility spawned pid=${String(childPID)}\n`)
    })
    child.stdout.on("data", (bytes) => {
      if (!parentGone) process.stdout.write(bytes)
    })
    child.stderr.on("data", (bytes) => {
      if (!parentGone) process.stderr.write(bytes)
    })
    child.once("exit", (code) => {
      finishing = true
      if (parentGone) return app.exit(1)
      process.stderr.write(`extension ownership utility exited pid=${String(childPID)} code=${String(code)}\n`)
      emit({ type: "utility-exit", pid: childPID, exitCode: code })
      process.stdout.end(() => app.exit(0))
    })
    const lines = createInterface({ input: process.stdin })
    lines.on("line", (line) => {
      try {
        const command = JSON.parse(line)
        if (command.type === "crash") {
          process.stderr.write(`extension ownership utility force-kill pid=${String(childPID)}\n`)
          process.kill(childPID, "SIGKILL")
        } else child.postMessage(command)
      } catch (error) {
        fail(error)
      }
    })
    lines.on("close", stop)
    process.on("SIGTERM", stop)
  })
  .catch(fail)
