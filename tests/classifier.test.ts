import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  classifyErrorImmediate,
  extractRateLimitHeaders,
  reclassify,
  type ReclassificationContext,
} from "../src/classifier.js"
import type { LimitHitEvent } from "../src/types.js"

// ============================================================
// classifyErrorImmediate
// ============================================================

describe("classifyErrorImmediate", () => {
  it("classifies preview limit from 'model capacity reached'", () => {
    const r = classifyErrorImmediate("model capacity reached", 429, undefined)
    assert.equal(r.class, "preview_limit")
  })

  it("classifies preview limit from 'model is currently unavailable'", () => {
    const r = classifyErrorImmediate("model is currently unavailable", 503, undefined)
    assert.equal(r.class, "preview_limit")
  })

  it("classifies preview limit from 'this model is at capacity'", () => {
    const r = classifyErrorImmediate("this model is at capacity", 429, undefined)
    assert.equal(r.class, "preview_limit")
  })

  it("classifies daily limit from 'exceeded your copilot token usage'", () => {
    const r = classifyErrorImmediate("exceeded your copilot token usage", 429, undefined)
    assert.equal(r.class, "hard_daily_limit")
    assert(r.confidence > 0)
  })

  it("classifies daily limit from 'rate_limited'", () => {
    const r = classifyErrorImmediate("rate_limited", 429, undefined)
    assert.equal(r.class, "hard_daily_limit")
  })

  it("classifies burst limit from 'too many requests' with 429", () => {
    const r = classifyErrorImmediate("too many requests", 429, undefined)
    assert.equal(r.class, "burst_rpm_limit")
  })

  it("classifies burst limit from 'throttled'", () => {
    const r = classifyErrorImmediate("throttled please slow down", 429, undefined)
    assert.equal(r.class, "burst_rpm_limit")
  })

  it("classifies 403 as model_blocked", () => {
    const r = classifyErrorImmediate("forbidden", 403, undefined)
    assert.equal(r.class, "model_blocked")
    assert(r.confidence >= 0.9)
  })

  it("classifies 403 as model_blocked even with unrecognized message", () => {
    const r = classifyErrorImmediate("some unknown error text", 403, undefined)
    assert.equal(r.class, "model_blocked")
  })

  it("classifies 'model not found' as model_blocked", () => {
    const r = classifyErrorImmediate("model not found", 404, undefined)
    assert.equal(r.class, "model_blocked")
  })

  it("classifies 'access denied' as model_blocked", () => {
    const r = classifyErrorImmediate("access denied to this resource", 200, undefined)
    assert.equal(r.class, "model_blocked")
  })

  it("classifies 'not available on plan' as model_blocked", () => {
    const r = classifyErrorImmediate("this model is not available on your plan", 200, undefined)
    assert.equal(r.class, "model_blocked")
  })

  it("does not classify preview messages as blocked", () => {
    const r = classifyErrorImmediate("model is currently unavailable", 503, undefined)
    assert.equal(r.class, "preview_limit")
  })

  it("returns unknown for unrecognized messages", () => {
    const r = classifyErrorImmediate("something went wrong internally", 500, undefined)
    assert.equal(r.class, "unknown")
    assert.equal(r.confidence, 0)
  })

  it("uses retry-after header to detect burst limit", () => {
    const headers = { "Retry-After": "30" }
    const r = classifyErrorImmediate("error", 429, headers)
    assert.equal(r.class, "burst_rpm_limit")
    assert(r.confidence > 0)
  })

  it("uses x-ratelimit-remaining=0 for rate limit detection", () => {
    const headers = { "X-RateLimit-Remaining": "0", "Retry-After": "60" }
    const r = classifyErrorImmediate("error", 429, headers)
    assert.equal(r.class, "burst_rpm_limit")
  })

  it("handles case-insensitive header lookup", () => {
    const headers = { "retry-after": "15" }
    const r = classifyErrorImmediate("error", 429, headers)
    assert.equal(r.class, "burst_rpm_limit")
  })
})

// ============================================================
// extractRateLimitHeaders
// ============================================================

describe("extractRateLimitHeaders", () => {
  it("returns null for undefined headers", () => {
    assert.equal(extractRateLimitHeaders(undefined), null)
  })

  it("returns null when no rate-limit headers present", () => {
    const headers = { "Content-Type": "application/json", "X-Request-Id": "abc" }
    assert.equal(extractRateLimitHeaders(headers), null)
  })

  it("extracts retry-after header", () => {
    const headers = { "Retry-After": "60" }
    const r = extractRateLimitHeaders(headers)
    assert.notEqual(r, null)
    assert.equal(r!.retryAfter, "60")
  })

  it("extracts x-ratelimit-* headers", () => {
    const headers = {
      "X-RateLimit-Limit": "5000",
      "X-RateLimit-Remaining": "4999",
      "X-RateLimit-Reset": "1234567890",
      "X-RateLimit-Used": "1",
      "X-RateLimit-Resource": "core",
    }
    const r = extractRateLimitHeaders(headers)
    assert.notEqual(r, null)
    assert.equal(r!.limit, "5000")
    assert.equal(r!.remaining, "4999")
    assert.equal(r!.reset, "1234567890")
    assert.equal(r!.used, "1")
    assert.equal(r!.resource, "core")
  })

  it("collects all rate-related headers in .all", () => {
    const headers = {
      "X-RateLimit-Limit": "100",
      "Content-Type": "json",
      "Retry-After": "30",
    }
    const r = extractRateLimitHeaders(headers)
    assert.notEqual(r, null)
    assert.equal(Object.keys(r!.all).length, 2) // RateLimit-Limit + Retry-After
  })
})

// ============================================================
// reclassify
// ============================================================

function makeLimitHit(overrides: Partial<LimitHitEvent> = {}): LimitHitEvent {
  return {
    ts: "2026-03-21T16:00:00Z",
    type: "limit_hit",
    session: "ses_abc",
    model: "claude-opus-4.5",
    provider: "github-copilot",
    day_cumulative_tokens: 2_800_000,
    day_cumulative_requests: 140,
    requests_last_minute: 5,
    error_name: "APIError",
    error_message: "rate_limited",
    error_raw: "{}",
    status_code: 429,
    is_retryable: true,
    response_headers: undefined,
    response_body: undefined,
    class: "unknown",
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ReclassificationContext> = {}): ReclassificationContext {
  return {
    recentObservations: [],
    dailyTokens: 2_800_000,
    dailyRequests: 140,
    globalEstimate: null,
    otherModelsWorking: false,
    workingModels: [],
    errorRate: 0,
    minutesSinceError: 10,
    hasRecovered: false,
    recoveryMinutes: null,
    ...overrides,
  }
}

describe("reclassify", () => {
  it("classifies as burst_rpm_limit when recovery < 30 min", () => {
    const r = reclassify(
      makeLimitHit(),
      makeCtx({ hasRecovered: true, recoveryMinutes: 5 })
    )
    assert.equal(r.newClass, "burst_rpm_limit")
    assert(r.confidence >= 0.7)
  })

  it("classifies as hard_daily_limit when recovery > 120 min", () => {
    const r = reclassify(
      makeLimitHit(),
      makeCtx({ hasRecovered: true, recoveryMinutes: 180 })
    )
    assert.equal(r.newClass, "hard_daily_limit")
    assert(r.confidence >= 0.7)
  })

  it("classifies as unknown_recovery when recovery 30-120 min", () => {
    const r = reclassify(
      makeLimitHit(),
      makeCtx({ hasRecovered: true, recoveryMinutes: 60 })
    )
    assert.equal(r.newClass, "unknown_recovery")
  })

  it("classifies as preview_limit when other models working", () => {
    const r = reclassify(
      makeLimitHit(),
      makeCtx({ otherModelsWorking: true, workingModels: ["gpt-5.4-mini"] })
    )
    assert.equal(r.newClass, "preview_limit")
    assert(r.confidence >= 0.7)
  })

  it("classifies as hard_daily_limit with high error rate", () => {
    const r = reclassify(
      makeLimitHit(),
      makeCtx({ errorRate: 0.85 })
    )
    assert.equal(r.newClass, "hard_daily_limit")
  })

  it("classifies as preview_limit when at < 30% of global estimate and others work", () => {
    const r = reclassify(
      makeLimitHit({ day_cumulative_tokens: 500_000 }),
      makeCtx({
        dailyTokens: 500_000,
        globalEstimate: 3_000_000,
        otherModelsWorking: true,
        workingModels: ["gpt-5.4-mini"],
      })
    )
    assert.equal(r.newClass, "preview_limit")
  })

  it("classifies as hard_daily_limit when at > 70% of global estimate", () => {
    const r = reclassify(
      makeLimitHit({ day_cumulative_tokens: 2_500_000 }),
      makeCtx({ dailyTokens: 2_500_000, globalEstimate: 3_000_000 })
    )
    assert.equal(r.newClass, "hard_daily_limit")
  })

  it("leans toward daily limit after 2h with no recovery", () => {
    const r = reclassify(
      makeLimitHit(),
      makeCtx({ minutesSinceError: 150, hasRecovered: false })
    )
    assert.equal(r.newClass, "hard_daily_limit")
  })

  it("reclassifies to model_blocked when 0 tokens and no recovery after 30 min", () => {
    const r = reclassify(
      makeLimitHit({ day_cumulative_tokens: 0, day_cumulative_requests: 0 }),
      makeCtx({ minutesSinceError: 45, hasRecovered: false, dailyTokens: 0, dailyRequests: 0 })
    )
    assert.equal(r.newClass, "model_blocked")
    assert(r.confidence >= 0.6)
  })

  it("does not reclassify to model_blocked if model has prior usage", () => {
    const r = reclassify(
      makeLimitHit({ day_cumulative_tokens: 500_000, day_cumulative_requests: 20 }),
      makeCtx({ minutesSinceError: 45, hasRecovered: false })
    )
    assert.notEqual(r.newClass, "model_blocked")
  })

  it("does not reclassify to model_blocked if recovered", () => {
    const r = reclassify(
      makeLimitHit({ day_cumulative_tokens: 0, day_cumulative_requests: 0 }),
      makeCtx({ minutesSinceError: 45, hasRecovered: true, recoveryMinutes: 20 })
    )
    assert.notEqual(r.newClass, "model_blocked")
  })

  it("keeps original class when insufficient data", () => {
    const r = reclassify(
      makeLimitHit({ class: "unknown" }),
      makeCtx({ minutesSinceError: 5 })
    )
    assert.equal(r.newClass, "unknown")
    assert.equal(r.confidence, 0)
  })
})
