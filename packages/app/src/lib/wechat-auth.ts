const terminal = new Set(["confirmed", "expired", "verify_code_blocked", "binded_redirect", "cancelled"])

export function isWechatLoginTerminal(status: string): boolean {
  return terminal.has(status)
}

export class WechatAuthRequestError extends Error {
  constructor(readonly retryable: boolean) {
    super("WeChat authorization response failed")
  }
}

export function requireWechatAuthData<T>(data: T | undefined, status: number): T {
  if (status >= 400) throw new WechatAuthRequestError(status >= 500 || status === 408 || status === 429)
  if (!data) throw new WechatAuthRequestError(true)
  return data
}

/** Generations fence late network responses after refresh, navigation, or unmount. */
export class WechatAuthGeneration {
  private generation = 0
  advance(): number {
    return ++this.generation
  }
  get value(): number {
    return this.generation
  }
}
