import type { IncomingMessage, IncomingError } from "../src/aggregator.js"

export function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg_${Math.random().toString(36).slice(2)}`,
    sessionId: "ses_test",
    modelId: "claude-opus-4.5",
    providerId: "github-copilot",
    tokens: {
      total: 10000,
      input: 5000,
      output: 3000,
      reasoning: 1000,
      cache: { read: 500, write: 500 },
    },
    cost: 0.01,
    finished: true,
    ...overrides,
  }
}

export function makeError(overrides: Partial<IncomingError> = {}): IncomingError {
  return {
    sessionId: "ses_test",
    errorName: "APIError",
    errorMessage: "rate_limited",
    errorRaw: "{}",
    statusCode: 429,
    isRetryable: true,
    responseHeaders: undefined,
    responseBody: undefined,
    ...overrides,
  }
}
