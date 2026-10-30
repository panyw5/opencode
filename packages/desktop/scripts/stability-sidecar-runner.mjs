process.parentPort = {
  postMessage: (message) => process.send(message),
  on: (_event, listener) => process.on("message", (data) => listener({ data })),
}

await import(process.argv[2])
process.send({ type: "booted" })
