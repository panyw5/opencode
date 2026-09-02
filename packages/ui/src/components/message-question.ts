export function isDismissedQuestion(input: {
  tool: string
  state: { status: string; error?: string }
}): boolean {
  return (
    input.tool === "question" &&
    input.state.status === "error" &&
    typeof input.state.error === "string" &&
    input.state.error.includes("dismissed this question")
  )
}
