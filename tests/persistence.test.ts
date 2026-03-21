import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createPersistence } from "../src/persistence.js"
import type { UsageEvent, LimitHitEvent } from "../src/types.js"

let tempDir: string
let p: ReturnType<typeof createPersistence>

function makeUsageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: new Date().toISOString(),
    type: "usage",
    session: "ses_test",
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
    ...overrides,
  }
}

function makeLimitHitEvent(overrides: Partial<LimitHitEvent> = {}): LimitHitEvent {
  return {
    ts: new Date().toISOString(),
    type: "limit_hit",
    session: "ses_test",
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

describe("persistence (with temp dir)", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "copilot-budget-test-"))
    p = createPersistence(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("JSONL append + read roundtrip", () => {
    it("writes and reads a single event", () => {
      const event = makeUsageEvent()
      p.appendObservation(event)
      const read = p.readObservations()
      assert.equal(read.length, 1)
      assert.equal(read[0].type, "usage")
      assert.equal(read[0].ts, event.ts)
    })

    it("writes and reads multiple events", () => {
      for (let i = 0; i < 10; i++) {
        p.appendObservation(makeUsageEvent({ day_cumulative_requests: i + 1 }))
      }
      const read = p.readObservations()
      assert.equal(read.length, 10)
    })

    it("returns empty array when file does not exist", () => {
      const read = p.readObservations()
      assert.equal(read.length, 0)
    })

    it("preserves all fields through roundtrip", () => {
      const event = makeUsageEvent({
        input_tokens: 12345,
        model: "gpt-5.4-mini",
        cost: 0.005,
      })
      p.appendObservation(event)
      const [read] = p.readObservations()
      assert.equal((read as UsageEvent).input_tokens, 12345)
      assert.equal((read as UsageEvent).model, "gpt-5.4-mini")
      assert.equal((read as UsageEvent).cost, 0.005)
    })
  })

  describe("filtered reads", () => {
    it("filters by type", () => {
      p.appendObservation(makeUsageEvent())
      p.appendObservation(makeLimitHitEvent())
      p.appendObservation(makeUsageEvent())

      const usage = p.readObservations({ type: "usage" })
      assert.equal(usage.length, 2)

      const limits = p.readObservations({ type: "limit_hit" })
      assert.equal(limits.length, 1)
    })

    it("filters by since timestamp", () => {
      p.appendObservation(makeUsageEvent({ ts: "2026-03-20T10:00:00Z" }))
      p.appendObservation(makeUsageEvent({ ts: "2026-03-21T10:00:00Z" }))
      p.appendObservation(makeUsageEvent({ ts: "2026-03-22T10:00:00Z" }))

      const since21 = p.readObservations({ since: "2026-03-21T00:00:00Z" })
      assert.equal(since21.length, 2)
    })

    it("combines type and since filters", () => {
      p.appendObservation(makeUsageEvent({ ts: "2026-03-20T10:00:00Z" }))
      p.appendObservation(makeLimitHitEvent({ ts: "2026-03-21T10:00:00Z" }))
      p.appendObservation(makeUsageEvent({ ts: "2026-03-22T10:00:00Z" }))

      const result = p.readObservations({
        type: "usage",
        since: "2026-03-21T00:00:00Z",
      })
      assert.equal(result.length, 1)
    })

    it("readTodayObservations filters correctly", () => {
      p.appendObservation(makeUsageEvent({ ts: "2026-03-20T23:59:59Z" }))
      p.appendObservation(makeUsageEvent({ ts: "2026-03-21T00:00:01Z" }))
      p.appendObservation(makeUsageEvent({ ts: "2026-03-21T15:30:00Z" }))

      const today = p.readTodayObservations("2026-03-21")
      assert.equal(today.length, 2)
    })
  })

  describe("estimates", () => {
    it("read returns null when file does not exist", () => {
      assert.equal(p.readEstimates(), null)
    })

    it("write then read roundtrip", () => {
      const data = {
        version: 1,
        totalDaysObserved: 5,
        nested: { value: 42 },
      }
      p.writeEstimates(data)
      const read = p.readEstimates()
      assert.deepEqual(read, data)
    })

    it("overwrites existing estimates", () => {
      p.writeEstimates({ v: 1 })
      p.writeEstimates({ v: 2 })
      const read = p.readEstimates()
      assert.deepEqual(read, { v: 2 })
    })
  })

  describe("config", () => {
    it("returns defaults when file does not exist", () => {
      const config = p.readConfig()
      assert.equal(config.copilot_plan, "pro")
      assert.equal(config.debug, false)
      assert.deepEqual(config.notification_thresholds, [60, 80, 95])
    })
  })

  describe("ensureDataDir", () => {
    it("creates directory if it does not exist", () => {
      const nested = join(tempDir, "sub", "dir")
      const np = createPersistence(nested)
      np.ensureDataDir()
      assert(existsSync(nested))
    })
  })
})
