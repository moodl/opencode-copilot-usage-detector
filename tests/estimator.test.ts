import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  weightedMean,
  stdDev,
  baseConfidence,
  confidenceWithDecay,
  checkThresholds,
} from "../src/estimator.js"

// ============================================================
// weightedMean
// ============================================================

describe("weightedMean", () => {
  it("returns 0 for empty arrays", () => {
    assert.equal(weightedMean([], []), 0)
  })

  it("returns the value when single element", () => {
    assert.equal(weightedMean([42], [1]), 42)
  })

  it("computes equal-weight mean", () => {
    assert.equal(weightedMean([10, 20, 30], [1, 1, 1]), 20)
  })

  it("applies weights correctly", () => {
    // 10*3 + 20*1 = 50, sum weights = 4, mean = 12.5
    assert.equal(weightedMean([10, 20], [3, 1]), 12.5)
  })

  it("returns 0 when all weights are 0", () => {
    assert.equal(weightedMean([10, 20], [0, 0]), 0)
  })
})

// ============================================================
// stdDev
// ============================================================

describe("stdDev", () => {
  it("returns 0 for empty array", () => {
    assert.equal(stdDev([]), 0)
  })

  it("returns 0 for single element", () => {
    assert.equal(stdDev([42]), 0)
  })

  it("returns 0 for identical values", () => {
    assert.equal(stdDev([5, 5, 5, 5]), 0)
  })

  it("computes correct sample std dev", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → sample stddev ≈ 2.138
    const sd = stdDev([2, 4, 4, 4, 5, 5, 7, 9])
    assert(Math.abs(sd - 2.138) < 0.01)
  })

  it("handles two elements", () => {
    // [0, 10] → mean=5, var=50, sd=√50≈7.071
    const sd = stdDev([0, 10])
    assert(Math.abs(sd - 7.071) < 0.01)
  })
})

// ============================================================
// baseConfidence
// ============================================================

describe("baseConfidence", () => {
  it("returns 0 for 0 data points", () => {
    assert.equal(baseConfidence(0), 0)
  })

  it("returns 0 for negative data points", () => {
    assert.equal(baseConfidence(-1), 0)
  })

  it("returns 0.4 for 1 data point", () => {
    assert.equal(baseConfidence(1), 0.4)
  })

  it("returns 0.55 for 2 data points", () => {
    assert.equal(baseConfidence(2), 0.55)
  })

  it("returns 0.7 for 3-4 data points", () => {
    assert.equal(baseConfidence(3), 0.7)
    assert.equal(baseConfidence(4), 0.7)
  })

  it("returns 0.85 for 5-6 data points", () => {
    assert.equal(baseConfidence(5), 0.85)
    assert.equal(baseConfidence(6), 0.85)
  })

  it("returns 0.95 for 7+ data points", () => {
    assert.equal(baseConfidence(7), 0.95)
    assert.equal(baseConfidence(100), 0.95)
  })
})

// ============================================================
// confidenceWithDecay
// ============================================================

describe("confidenceWithDecay", () => {
  it("returns maximum confidence for 0 days since hit", () => {
    const c = confidenceWithDecay(7, 0) // 0.95 * 1.0
    assert.equal(c, 0.95)
  })

  it("decays confidence over time", () => {
    const recent = confidenceWithDecay(5, 1)
    const old = confidenceWithDecay(5, 30)
    assert(recent > old)
  })

  it("handles Infinity without NaN", () => {
    const c = confidenceWithDecay(5, Infinity)
    assert(!isNaN(c))
    assert(c > 0)
    // Should be base * 0.3 = 0.85 * 0.3 = 0.255
    assert(Math.abs(c - 0.255) < 0.01)
  })

  it("handles very large daysSinceLastHit", () => {
    const c = confidenceWithDecay(5, 100_000)
    assert(!isNaN(c))
    assert(c > 0)
  })

  it("returns 0 for 0 data points regardless of decay", () => {
    assert.equal(confidenceWithDecay(0, 0), 0)
    assert.equal(confidenceWithDecay(0, 10), 0)
  })

  it("never drops below base * 0.3", () => {
    const c = confidenceWithDecay(7, 59) // near DECAY_MAX_DAYS
    assert(c >= 0.95 * 0.3 - 0.01)
  })
})

// ============================================================
// checkThresholds
// ============================================================

describe("checkThresholds", () => {
  it("returns null when percentage is null", () => {
    assert.equal(checkThresholds(null, [60, 80, 95], new Set()), null)
  })

  it("returns null when below all thresholds", () => {
    assert.equal(checkThresholds(50, [60, 80, 95], new Set()), null)
  })

  it("returns first exceeded threshold", () => {
    assert.equal(checkThresholds(65, [60, 80, 95], new Set()), 60)
  })

  it("skips already-notified thresholds", () => {
    assert.equal(checkThresholds(65, [60, 80, 95], new Set([60])), null)
  })

  it("returns next unnotified threshold", () => {
    assert.equal(checkThresholds(85, [60, 80, 95], new Set([60])), 80)
  })

  it("returns highest matching unnotified threshold", () => {
    assert.equal(checkThresholds(99, [60, 80, 95], new Set([60, 80])), 95)
  })

  it("handles exact threshold match", () => {
    assert.equal(checkThresholds(80, [60, 80, 95], new Set()), 60)
  })

  it("returns null when all thresholds already notified", () => {
    assert.equal(checkThresholds(99, [60, 80, 95], new Set([60, 80, 95])), null)
  })
})
