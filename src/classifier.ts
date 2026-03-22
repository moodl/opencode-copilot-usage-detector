import type { LimitClass, LimitHitEvent } from "./types.js"
import { readObservations, appendObservation } from "./persistence.js"
import { debugLogError } from "./debug.js"

// ============================================================
// Stage 1: Immediate classification from error message patterns
// ============================================================

const PREVIEW_LIMIT_PATTERNS = [
  "model is currently unavailable",
  "model capacity reached",
  "this model is at capacity",
  "model.*unavailable",
  "preview.*limit",
  "model.*capacity",
]

const DAILY_LIMIT_PATTERNS = [
  "exceeded your copilot token usage",
  "exceeded.*token.*usage",
  "rate_limited",
  "daily.*limit",
  "usage.*limit.*reached",
]

const BURST_LIMIT_PATTERNS = [
  "too many requests",
  "requests.*per.*minute",
  "throttl",
  "slow down",
]

const MODEL_BLOCKED_PATTERNS = [
  "not available.*plan",
  "not supported",
  "forbidden",
  "access denied",
  "not authorized.*model",
  "not included.*plan",
  "model not found",
  "not allowed",
  "does not have access",
  "not enabled",
]

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase()
  return patterns.some((p) => {
    if (p.includes(".*")) {
      return new RegExp(p, "i").test(text)
    }
    return lower.includes(p)
  })
}

export function classifyErrorImmediate(
  errorMessage: string,
  statusCode: number | undefined,
  responseHeaders: Record<string, string> | undefined
): { class: LimitClass; confidence: number; reason: string } {
  const msg = errorMessage.toLowerCase()

  // Check for blocked model first — 403 is a strong signal
  if (statusCode === 403) {
    return {
      class: "model_blocked",
      confidence: 0.95,
      reason: "status_403_forbidden",
    }
  }
  if (matchesAny(errorMessage, MODEL_BLOCKED_PATTERNS)) {
    return {
      class: "model_blocked",
      confidence: 0.6,
      reason: "error_message_matches_blocked_pattern",
    }
  }

  // Check for rate-limit headers first — these are the most reliable signal
  if (responseHeaders) {
    const retryAfter = findHeader(responseHeaders, "retry-after")
    const rateLimitRemaining = findHeader(responseHeaders, "x-ratelimit-remaining")
    const rateLimitReset = findHeader(responseHeaders, "x-ratelimit-reset")

    if (retryAfter || rateLimitRemaining === "0") {
      // Headers present — likely a real rate limit. Try to determine type from context.
      const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : NaN
      if (!isNaN(retrySeconds) && retrySeconds < 120) {
        return {
          class: "burst_rpm_limit",
          confidence: 0.8,
          reason: `retry-after=${retrySeconds}s suggests burst/RPM limit`,
        }
      }
    }

    // Log all rate-limit-related headers for future analysis
    if (rateLimitReset || rateLimitRemaining) {
      // We have headers but can't fully classify yet — proceed with message analysis
    }
  }

  // 429 status code without clear message
  if (statusCode === 429 && matchesAny(errorMessage, BURST_LIMIT_PATTERNS)) {
    return {
      class: "burst_rpm_limit",
      confidence: 0.6,
      reason: "status_429_with_burst_pattern",
    }
  }

  // Check known patterns
  if (matchesAny(errorMessage, PREVIEW_LIMIT_PATTERNS)) {
    return {
      class: "preview_limit",
      confidence: 0.7,
      reason: "error_message_matches_preview_pattern",
    }
  }

  if (matchesAny(errorMessage, DAILY_LIMIT_PATTERNS)) {
    return {
      class: "hard_daily_limit",
      confidence: 0.5, // Lower confidence — wait for reclassification to confirm
      reason: "error_message_matches_daily_pattern",
    }
  }

  // Unknown — will be reclassified later
  return {
    class: "unknown",
    confidence: 0,
    reason: "no_pattern_match",
  }
}

// ============================================================
// Rate-limit header extraction
// ============================================================

function findHeader(
  headers: Record<string, string>,
  name: string
): string | undefined {
  // Headers may be case-insensitive
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

export interface RateLimitHeaders {
  retryAfter: string | null
  remaining: string | null
  limit: string | null
  reset: string | null
  used: string | null
  resource: string | null
  all: Record<string, string>
}

export function extractRateLimitHeaders(
  headers: Record<string, string> | undefined
): RateLimitHeaders | null {
  if (!headers) return null

  const relevant: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (
      lower.includes("rate") ||
      lower.includes("retry") ||
      lower.includes("limit") ||
      lower.includes("throttl") ||
      lower.includes("remaining")
    ) {
      relevant[key] = value
    }
  }

  if (Object.keys(relevant).length === 0) return null

  return {
    retryAfter: findHeader(headers, "retry-after") ?? null,
    remaining: findHeader(headers, "x-ratelimit-remaining") ?? null,
    limit: findHeader(headers, "x-ratelimit-limit") ?? null,
    reset: findHeader(headers, "x-ratelimit-reset") ?? null,
    used: findHeader(headers, "x-ratelimit-used") ?? null,
    resource: findHeader(headers, "x-ratelimit-resource") ?? null,
    all: relevant,
  }
}

// ============================================================
// Stage 2-5: Delayed reclassification (called by timer)
// ============================================================

export interface ReclassificationContext {
  /** Observations from the last N minutes after the original error */
  recentObservations: Array<{ type: string; model?: string; ts: string }>
  /** Current daily token total */
  dailyTokens: number
  /** Current daily request total */
  dailyRequests: number
  /** Current global budget estimate (if available) */
  globalEstimate: number | null
  /** Whether other models had successful requests since the error */
  otherModelsWorking: boolean
  /** List of models that worked since the error */
  workingModels: string[]
  /** Error rate in the reclassification window */
  errorRate: number
  /** Minutes since the original error */
  minutesSinceError: number
  /** Whether we've observed a recovery (successful request after limit) */
  hasRecovered: boolean
  /** Minutes from error to recovery (if recovered) */
  recoveryMinutes: number | null
}

export function reclassify(
  originalEvent: LimitHitEvent,
  ctx: ReclassificationContext
): { newClass: LimitClass; confidence: number; reason: string } {
  // Check for blocked model: zero usage and no recovery after 30 min
  if (
    originalEvent.day_cumulative_tokens === 0 &&
    originalEvent.day_cumulative_requests === 0 &&
    !ctx.hasRecovered &&
    ctx.minutesSinceError > 30
  ) {
    return {
      newClass: "model_blocked",
      confidence: 0.7,
      reason: "zero_usage_no_recovery_suggests_blocked",
    }
  }

  // Stage 5: If we have recovery data, use recovery time to classify
  if (ctx.hasRecovered && ctx.recoveryMinutes !== null) {
    if (ctx.recoveryMinutes < 30) {
      return {
        newClass: "burst_rpm_limit",
        confidence: 0.8,
        reason: `recovered_in_${Math.round(ctx.recoveryMinutes)}min_suggests_burst_limit`,
      }
    }
    if (ctx.recoveryMinutes > 120) {
      return {
        newClass: "hard_daily_limit",
        confidence: 0.8,
        reason: `no_recovery_for_${Math.round(ctx.recoveryMinutes)}min_suggests_daily_limit`,
      }
    }
    // Between 30-120 min — ambiguous
    return {
      newClass: "unknown_recovery",
      confidence: 0.4,
      reason: `recovery_in_${Math.round(ctx.recoveryMinutes)}min_ambiguous`,
    }
  }

  // Stage 2: Cross-model correlation
  if (ctx.otherModelsWorking && ctx.workingModels.length > 0) {
    return {
      newClass: "preview_limit",
      confidence: 0.75,
      reason: `only_${originalEvent.model}_affected_other_models_working: ${ctx.workingModels.join(",")}`,
    }
  }

  // Stage 3: Cancel-rate analysis
  if (ctx.errorRate > 0.7) {
    // High error rate — all models seem affected
    return {
      newClass: "hard_daily_limit",
      confidence: 0.7,
      reason: `cancel_rate_${(ctx.errorRate * 100).toFixed(0)}pct_suggests_global_limit`,
    }
  }

  // Stage 4: Budget comparison
  if (ctx.globalEstimate !== null && ctx.globalEstimate > 0) {
    const pct = ctx.dailyTokens / ctx.globalEstimate

    if (pct < 0.3 && ctx.otherModelsWorking) {
      return {
        newClass: "preview_limit",
        confidence: 0.7,
        reason: `hit_at_${(pct * 100).toFixed(0)}pct_of_global_estimate_suggests_preview`,
      }
    }

    if (pct > 0.7) {
      return {
        newClass: "hard_daily_limit",
        confidence: 0.65,
        reason: `hit_at_${(pct * 100).toFixed(0)}pct_of_global_estimate_suggests_daily`,
      }
    }
  }

  // Not enough info to reclassify — keep as-is
  if (!ctx.hasRecovered && ctx.minutesSinceError > 120) {
    // If we haven't recovered after 2 hours and have no other data, lean toward daily limit
    return {
      newClass: "hard_daily_limit",
      confidence: 0.5,
      reason: "no_recovery_after_2h_no_other_signals",
    }
  }

  return {
    newClass: originalEvent.class,
    confidence: 0,
    reason: "insufficient_data_for_reclassification",
  }
}

// ============================================================
// Schedule reclassification
// ============================================================

const RECLASSIFY_DELAY_MS = 10 * 60 * 1000 // 10 minutes
const pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

export function scheduleReclassification(
  eventTs: string,
  buildContext: () => ReclassificationContext
): void {
  // Clear any existing timer for this event
  const existing = pendingTimers.get(eventTs)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    pendingTimers.delete(eventTs)
    try {
      performReclassification(eventTs, buildContext)
    } catch (e) {
      debugLogError("classifier.scheduleReclassification", e)
    }
  }, RECLASSIFY_DELAY_MS)

  // Don't prevent process exit while waiting for reclassification
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref()
  }

  pendingTimers.set(eventTs, timer)
}

function performReclassification(
  eventTs: string,
  buildContext: () => ReclassificationContext
): void {
  // Find the original event
  const allEvents = readObservations({ type: "limit_hit" })
  const original = allEvents.find(
    (e) => e.type === "limit_hit" && e.ts === eventTs
  ) as LimitHitEvent | undefined

  if (!original) return

  const ctx = buildContext()
  const result = reclassify(original, ctx)

  // Only write reclassify event if we actually changed the class
  if (result.newClass !== original.class && result.confidence > 0) {
    appendObservation({
      ts: new Date().toISOString(),
      type: "reclassify",
      ref_ts: eventTs,
      old_class: original.class,
      new_class: result.newClass,
      reason: result.reason,
      evidence: {
        confidence: result.confidence,
        daily_tokens: ctx.dailyTokens,
        daily_requests: ctx.dailyRequests,
        error_rate: ctx.errorRate,
        other_models_working: ctx.otherModelsWorking,
        working_models: ctx.workingModels,
        minutes_since_error: ctx.minutesSinceError,
        has_recovered: ctx.hasRecovered,
        recovery_minutes: ctx.recoveryMinutes,
        global_estimate: ctx.globalEstimate,
      },
    })
  }
}

// ============================================================
// Cleanup
// ============================================================

export function clearPendingTimers(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
}
