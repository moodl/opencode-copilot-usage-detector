import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createPersistence, type PersistenceInstance } from "../src/persistence.js"
import {
  resetState,
  processAssistantMessage,
  processErrorEvent,
  getDaily,
} from "../src/aggregator.js"
import { classifyErrorImmediate } from "../src/classifier.js"
import { checkThresholds } from "../src/estimator.js"
import type { UsageEvent, LimitHitEvent } from "../src/types.js"
import { makeMessage, makeError } from "./factories.js"

let tempDir: string
let p: PersistenceInstance

describe("integration", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "copilot-budget-integration-"))
    p = createPersistence(tempDir)
    resetState()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("full usage event flow", () => {
    it("processes N events and verifies daily state consistency", () => {
      const N = 20
      for (let i = 0; i < N; i++) {
        const msg = makeMessage({
          modelId: i % 3 === 0 ? "gpt-5.4-mini" : "claude-opus-4.5",
        })
        processAssistantMessage(msg)

        // Also write to our temp persistence
        const d = getDaily()
        p.appendObservation({
          ts: new Date().toISOString(),
          type: "usage",
          session: msg.sessionId,
          model: msg.modelId,
          provider: msg.providerId,
          input_tokens: msg.tokens.input,
          output_tokens: msg.tokens.output,
          reasoning_tokens: msg.tokens.reasoning,
          cache_read: msg.tokens.cache.read,
          cache_write: msg.tokens.cache.write,
          cost: msg.cost,
          day_cumulative_tokens: d.totalTokens,
          day_cumulative_requests: d.totalRequests,
          requests_last_minute: 1,
          request_ok: true,
        })
      }

      const daily = getDaily()
      assert.equal(daily.totalRequests, N)
      assert.equal(daily.totalTokens, N * 10000)

      // Verify model split: 7 mini (indices 0,3,6,9,12,15,18) and 13 opus
      assert.equal(daily.byModel["gpt-5.4-mini"]?.requests, 7)
      assert.equal(daily.byModel["claude-opus-4.5"]?.requests, 13)

      // Verify persistence matches
      const obs = p.readObservations({ type: "usage" })
      assert.equal(obs.length, N)
    })
  })

  describe("limit hit + classification flow", () => {
    it("processes usage events then a limit hit", () => {
      // Generate some usage first
      for (let i = 0; i < 5; i++) {
        processAssistantMessage(makeMessage())
      }

      // Trigger a rate limit error
      const ts = processErrorEvent(makeError(), "claude-opus-4.5", "github-copilot")
      assert(typeof ts === "string")

      const daily = getDaily()
      assert.equal(daily.limitHits.length, 1)
      assert.equal(daily.inLimitState, true)
      assert.equal(daily.limitHits[0].model, "claude-opus-4.5")
      assert.equal(daily.limitHits[0].tokensAtHit, 50000) // 5 * 10000

      // Classify the error
      const classification = classifyErrorImmediate(
        "rate_limited",
        429,
        undefined
      )
      assert.equal(classification.class, "hard_daily_limit")
    })
  })

  describe("recovery detection flow", () => {
    it("detects recovery after limit hit followed by successful message", () => {
      // Usage
      processAssistantMessage(makeMessage())

      // Limit hit
      processErrorEvent(makeError(), "claude-opus-4.5", "github-copilot")
      assert.equal(getDaily().inLimitState, true)

      // Recovery (successful message)
      processAssistantMessage(makeMessage())
      assert.equal(getDaily().inLimitState, false)
    })
  })

  describe("threshold notification logic", () => {
    it("triggers at correct percentages", () => {
      const thresholds = [60, 80, 95]
      const notified = new Set<number>()

      // 50% — no notification
      assert.equal(checkThresholds(50, thresholds, notified), null)

      // 65% — should trigger 60
      const t1 = checkThresholds(65, thresholds, notified)
      assert.equal(t1, 60)
      notified.add(60)

      // 70% — already notified 60, below 80
      assert.equal(checkThresholds(70, thresholds, notified), null)

      // 82% — should trigger 80
      const t2 = checkThresholds(82, thresholds, notified)
      assert.equal(t2, 80)
      notified.add(80)

      // 96% — should trigger 95
      const t3 = checkThresholds(96, thresholds, notified)
      assert.equal(t3, 95)
      notified.add(95)

      // 99% — all thresholds notified
      assert.equal(checkThresholds(99, thresholds, notified), null)
    })
  })

  describe("multi-model tracking", () => {
    it("correctly tracks multiple models independently", () => {
      const models = ["claude-opus-4.5", "gpt-5.4-mini", "claude-sonnet-4.5"]

      for (const model of models) {
        for (let i = 0; i < 3; i++) {
          processAssistantMessage(makeMessage({ modelId: model }))
        }
      }

      const daily = getDaily()
      assert.equal(daily.totalRequests, 9)
      assert.equal(Object.keys(daily.byModel).length, 3)

      for (const model of models) {
        assert.equal(daily.byModel[model]?.requests, 3)
        assert.equal(daily.byModel[model]?.tokens, 30000)
      }
    })
  })

  describe("persistence roundtrip with classification", () => {
    it("writes events and reads back with correct types", () => {
      const usage: UsageEvent = {
        ts: "2026-03-21T10:00:00Z",
        type: "usage",
        session: "ses1",
        model: "claude-opus-4.5",
        provider: "github-copilot",
        input_tokens: 5000,
        output_tokens: 3000,
        reasoning_tokens: 500,
        cache_read: 300,
        cache_write: 200,
        cost: 0.01,
        day_cumulative_tokens: 9000,
        day_cumulative_requests: 1,
        requests_last_minute: 1,
        request_ok: true,
      }

      const limitHit: LimitHitEvent = {
        ts: "2026-03-21T16:00:00Z",
        type: "limit_hit",
        session: "ses1",
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
        class: "hard_daily_limit",
      }

      p.appendObservation(usage)
      p.appendObservation(limitHit)

      const all = p.readObservations()
      assert.equal(all.length, 2)
      assert.equal(all[0].type, "usage")
      assert.equal(all[1].type, "limit_hit")

      const usageOnly = p.readObservations({ type: "usage" })
      assert.equal(usageOnly.length, 1)

      const limitsOnly = p.readObservations({ type: "limit_hit" })
      assert.equal(limitsOnly.length, 1)
      assert.equal((limitsOnly[0] as LimitHitEvent).class, "hard_daily_limit")
    })
  })

  describe("error classification pipeline", () => {
    it("classifies different error types correctly", () => {
      const cases = [
        { msg: "model capacity reached", expected: "preview_limit" },
        { msg: "exceeded your copilot token usage", expected: "hard_daily_limit" },
        { msg: "too many requests", code: 429, expected: "burst_rpm_limit" },
        { msg: "internal server error", code: 500, expected: "unknown" },
      ] as const

      for (const { msg, expected, ...rest } of cases) {
        const result = classifyErrorImmediate(
          msg,
          "code" in rest ? rest.code : 429,
          undefined
        )
        assert.equal(
          result.class,
          expected,
          `Expected "${msg}" to classify as ${expected}, got ${result.class}`
        )
      }
    })
  })
})
