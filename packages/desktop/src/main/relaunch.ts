type RelaunchTarget = {
  isPackaged: boolean
  getAppPath(): string
  relaunch(options?: { args: string[] }): void
}

export function relaunchApp(app: RelaunchTarget, argv = process.argv) {
  if (app.isPackaged) {
    app.relaunch()
    return
  }
  app.relaunch({ args: [app.getAppPath(), ...argv.slice(2)] })
}
