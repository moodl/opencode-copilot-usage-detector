import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  processAssistantMessage,
  processErrorEvent,
  getDaily,
  getCurrentRPM,
  recoverFromJSONL,
  resetState,
} from "../src/aggregator.js"
import { makeMessage, makeError } from "./factories.js"

describe("aggregator", () => {
  beforeEach(() => {
    resetState()
  })

  describe("processAssistantMessage", () => {
    it("accumulates tokens in daily state", () => {
      processAssistantMessage(makeMessage())
      const d = getDaily()
      assert.equal(d.totalTokens, 10000)
      assert.equal(d.totalRequests, 1)
      assert(d.totalCost > 0)
    })

    it("tracks per-model usage", () => {
      processAssistantMessage(makeMessage({ modelId: "claude-opus-4.5" }))
      processAssistantMessage(makeMessage({ modelId: "gpt-5.4-mini" }))
      const d = getDaily()
      assert.equal(Object.keys(d.byModel).length, 2)
      assert.equal(d.byModel["claude-opus-4.5"]?.tokens, 10000)
      assert.equal(d.byModel["gpt-5.4-mini"]?.tokens, 10000)
    })

    it("deduplicates by messageId", () => {
      const msg = makeMessage({ messageId: "msg_dup" })
      processAssistantMessage(msg)
      processAssistantMessage(msg) // same ID
      const d = getDaily()
      assert.equal(d.totalRequests, 1) // only counted once
    })

    it("skips unfinished messages", () => {
      processAssistantMessage(makeMessage({ finished: false }))
      const d = getDaily()
      assert.equal(d.totalRequests, 0)
    })

    it("skips zero-token messages", () => {
      processAssistantMessage(
        makeMessage({
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      )
      const d = getDaily()
      assert.equal(d.totalRequests, 0)
    })

    it("accumulates multiple messages", () => {
      for (let i = 0; i < 5; i++) {
        processAssistantMessage(makeMessage())
      }
      const d = getDaily()
      assert.equal(d.totalRequests, 5)
      assert.equal(d.totalTokens, 50000)
    })

    it("sums all token fields correctly", () => {
      processAssistantMessage(
        makeMessage({
          tokens: {
            total: 0, // total is computed by aggregator
            input: 1000,
            output: 2000,
            reasoning: 500,
            cache: { read: 300, write: 200 },
          },
        })
      )
      const d = getDaily()
      assert.equal(d.totalTokens, 4000) // 1000+2000+500+300+200
    })
  })

  describe("processErrorEvent", () => {
    it("returns the timestamp it wrote", () => {
      const ts = processErrorEvent(makeError(), "claude-opus-4.5", "github-copilot")
      assert(typeof ts === "string")
      assert(ts.includes("T")) // ISO format
    })

    it("records limit hit in daily state", () => {
      processErrorEvent(makeError(), "claude-opus-4.5", "github-copilot")
      const d = getDaily()
      assert.equal(d.limitHits.length, 1)
      assert.equal(d.limitHits[0].model, "claude-opus-4.5")
      assert.equal(d.inLimitState, true)
    })

    it("sets inLimitState to true", () => {
      processErrorEvent(makeError(), "claude-opus-4.5", "github-copilot")
      assert.equal(getDaily().inLimitState, true)
    })
  })

  describe("recovery detection", () => {
    it("detects recovery when message arrives after limit hit", () => {
      // First, trigger a limit state
      processErrorEvent(makeError(), "claude-opus-4.5", "github-copilot")
      assert.equal(getDaily().inLimitState, true)

      // Then send a successful message — should trigger recovery
      processAssistantMessage(makeMessage())
      assert.equal(getDaily().inLimitState, false)
    })
  })

  describe("RPM tracking", () => {
    it("tracks request timestamps", () => {
      processAssistantMessage(makeMessage())
      const rpm = getCurrentRPM()
      assert(rpm >= 1)
    })

    it("tracks peak RPM", () => {
      for (let i = 0; i < 10; i++) {
        processAssistantMessage(makeMessage())
      }
      const d = getDaily()
      assert(d.peakRPM >= 10)
    })
  })

  describe("resetState", () => {
    it("clears all state", () => {
      processAssistantMessage(makeMessage())
      processErrorEvent(makeError(), "test", "test")
      resetState()
      const d = getDaily()
      assert.equal(d.totalTokens, 0)
      assert.equal(d.totalRequests, 0)
      assert.equal(d.limitHits.length, 0)
      assert.equal(d.inLimitState, false)
    })
  })
})
