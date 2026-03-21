import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  formatTokensShort,
  isAssistantMessage,
  isApiError,
  isRateLimitError,
  isModelBlockedError,
} from "../src/copilot-budget.js"

// ============================================================
// formatTokensShort
// ============================================================

describe("formatTokensShort", () => {
  it("formats millions", () => {
    assert.equal(formatTokensShort(1_500_000), "1.5M")
    assert.equal(formatTokensShort(2_900_000), "2.9M")
    assert.equal(formatTokensShort(1_000_000), "1.0M")
  })

  it("formats thousands", () => {
    assert.equal(formatTokensShort(1_000), "1K")
    assert.equal(formatTokensShort(45_000), "45K")
    assert.equal(formatTokensShort(999_999), "1000K")
  })

  it("formats small numbers as-is", () => {
    assert.equal(formatTokensShort(0), "0")
    assert.equal(formatTokensShort(500), "500")
    assert.equal(formatTokensShort(999), "999")
  })
})

// ============================================================
// isAssistantMessage
// ============================================================

describe("isAssistantMessage", () => {
  it("returns true for valid assistant message", () => {
    assert.equal(
      isAssistantMessage({ role: "assistant", id: "msg_123", sessionID: "s1" }),
      true
    )
  })

  it("returns false for user message", () => {
    assert.equal(
      isAssistantMessage({ role: "user", id: "msg_123" }),
      false
    )
  })

  it("returns false for null", () => {
    assert.equal(isAssistantMessage(null), false)
  })

  it("returns false for undefined", () => {
    assert.equal(isAssistantMessage(undefined), false)
  })

  it("returns false for non-object", () => {
    assert.equal(isAssistantMessage("assistant"), false)
    assert.equal(isAssistantMessage(42), false)
  })

  it("returns false for missing id", () => {
    assert.equal(isAssistantMessage({ role: "assistant" }), false)
  })

  it("returns false for non-string id", () => {
    assert.equal(isAssistantMessage({ role: "assistant", id: 123 }), false)
  })
})

// ============================================================
// isApiError
// ============================================================

describe("isApiError", () => {
  it("returns true for APIError", () => {
    assert.equal(
      isApiError({ name: "APIError", data: { message: "err" } }),
      true
    )
  })

  it("returns false for other error types", () => {
    assert.equal(isApiError({ name: "ProviderAuthError" }), false)
    assert.equal(isApiError({ name: "UnknownError" }), false)
  })

  it("returns false for null", () => {
    assert.equal(isApiError(null), false)
  })

  it("returns false for non-object", () => {
    assert.equal(isApiError("APIError"), false)
  })
})

// ============================================================
// isRateLimitError
// ============================================================

describe("isRateLimitError", () => {
  it("returns true for 429 status", () => {
    const err = { name: "APIError" as const, data: { statusCode: 429, message: "error", isRetryable: true } }
    assert.equal(isRateLimitError(err), true)
  })

  it("returns true for rate-related message", () => {
    const err = { name: "APIError" as const, data: { message: "rate_limited", isRetryable: true } }
    assert.equal(isRateLimitError(err), true)
  })

  it("returns true for limit-related message", () => {
    const err = { name: "APIError" as const, data: { message: "exceeded your limit", isRetryable: true } }
    assert.equal(isRateLimitError(err), true)
  })

  it("returns true for capacity message", () => {
    const err = { name: "APIError" as const, data: { message: "model at capacity", isRetryable: true } }
    assert.equal(isRateLimitError(err), true)
  })

  it("returns true for throttle message", () => {
    const err = { name: "APIError" as const, data: { message: "request throttled", isRetryable: true } }
    assert.equal(isRateLimitError(err), true)
  })

  it("returns false for non-rate-limit errors", () => {
    const err = { name: "APIError" as const, data: { statusCode: 500, message: "internal server error", isRetryable: false } }
    assert.equal(isRateLimitError(err), false)
  })

  it("returns false for auth errors", () => {
    const err = { name: "APIError" as const, data: { statusCode: 401, message: "unauthorized", isRetryable: false } }
    assert.equal(isRateLimitError(err), false)
  })
})

// ============================================================
// isModelBlockedError
// ============================================================

describe("isModelBlockedError", () => {
  it("returns true for 403 status regardless of message or prior usage", () => {
    const err = { name: "APIError" as const, data: { statusCode: 403, message: "forbidden", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 100_000, 10), true)
  })

  it("returns true for 403 even with empty message", () => {
    const err = { name: "APIError" as const, data: { statusCode: 403, message: "", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 0, 0), true)
  })

  it("returns true for blocked message patterns with 0 usage", () => {
    const err = { name: "APIError" as const, data: { statusCode: 200, message: "Model not found", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 0, 0), true)
  })

  it("returns true for 'not available' with 0 usage", () => {
    const err = { name: "APIError" as const, data: { statusCode: 200, message: "This model is not available for your account", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 0, 0), true)
  })

  it("returns false for blocked message patterns WITH prior usage", () => {
    const err = { name: "APIError" as const, data: { statusCode: 200, message: "Model not found", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 50_000, 5), false)
  })

  it("returns true for 401 with model-specific denial", () => {
    const err = { name: "APIError" as const, data: { statusCode: 401, message: "not authorized for this model", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 0, 0), true)
  })

  it("returns false for generic 401 unauthorized", () => {
    const err = { name: "APIError" as const, data: { statusCode: 401, message: "unauthorized", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 0, 0), false)
  })

  it("returns false for 429 rate limit", () => {
    const err = { name: "APIError" as const, data: { statusCode: 429, message: "too many requests", isRetryable: true } }
    assert.equal(isModelBlockedError(err, 0, 0), false)
  })

  it("returns false for 500 internal error", () => {
    const err = { name: "APIError" as const, data: { statusCode: 500, message: "internal server error", isRetryable: false } }
    assert.equal(isModelBlockedError(err, 0, 0), false)
  })

  it("returns false for undefined message", () => {
    const err = { name: "APIError" as const, data: { statusCode: 200 } }
    assert.equal(isModelBlockedError(err, 0, 0), false)
  })
})
