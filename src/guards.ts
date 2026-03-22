import type { AssistantMessage, ApiError } from "@opencode-ai/sdk"

export function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  if (typeof msg !== "object" || msg === null) return false
  const obj = msg as Record<string, unknown>
  return obj.role === "assistant" && typeof obj.id === "string"
}

export function isApiError(error: unknown): error is ApiError {
  if (typeof error !== "object" || error === null) return false
  return (error as Record<string, unknown>).name === "APIError"
}

const MODEL_BLOCKED_MESSAGE_PATTERNS = [
  "not available",
  "not supported",
  "model_not_supported",
  "forbidden",
  "access denied",
  "not authorized",
  "not included",
  "not enabled",
  "model not found",
  "not allowed",
  "not permitted",
  "does not have access",
  "not part of your",
  "unavailable for your",
]

export function isModelBlockedError(
  error: ApiError,
  modelCumulativeTokens: number,
  modelCumulativeRequests: number
): boolean {
  const code = error.data?.statusCode
  const msg = error.data?.message?.toLowerCase() ?? ""

  // 403 Forbidden — always blocked
  if (code === 403) return true

  // Message patterns + model was never successfully used
  if (modelCumulativeTokens === 0 && modelCumulativeRequests === 0) {
    if (MODEL_BLOCKED_MESSAGE_PATTERNS.some((p) => msg.includes(p))) return true
  }

  // 400/401 with model-specific denial message
  if ((code === 400 || code === 401) && MODEL_BLOCKED_MESSAGE_PATTERNS.some((p) => msg.includes(p))) {
    return true
  }

  return false
}

export function isRateLimitError(error: ApiError): boolean {
  const code = error.data?.statusCode
  const msg = error.data?.message?.toLowerCase() ?? ""
  return (
    code === 429 ||
    msg.includes("rate") ||
    msg.includes("limit") ||
    msg.includes("exceeded") ||
    msg.includes("capacity") ||
    msg.includes("throttl")
  )
}
