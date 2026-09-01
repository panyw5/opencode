export function leaveMathDetailsForWorker(input: { close: () => void; open: () => void }) {
  input.close()
  input.open()
}
