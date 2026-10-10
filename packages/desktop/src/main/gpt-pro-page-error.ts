/** An explicit website rejection is terminal, unlike an uncertain monitoring failure. */
export class GptProPageError extends Error {
  constructor(
    message: string,
    readonly kind?: "verification" | "request" | "login",
  ) {
    super(message)
  }
}
