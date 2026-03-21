import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  parsePremiumRequestResponse,
  formatPremiumRequestStatus,
  resetApiState,
} from "../src/github-api.js"
import type { PluginConfig } from "../src/types.js"
import { DEFAULT_CONFIG } from "../src/types.js"

const config: PluginConfig = {
  ...DEFAULT_CONFIG,
  copilot_plan: "pro",
  monthly_premium_allowance: 300,
}

describe("github-api", () => {
  beforeEach(() => {
    resetApiState()
  })

  describe("parsePremiumRequestResponse", () => {
    it("parses array response with usage items", () => {
      const data = [
        { quantity: 10, sku: "claude-opus-4.5", product: "copilot_chat" },
        { quantity: 5, sku: "gpt-5.4-mini", product: "copilot_chat" },
        { quantity: 3, sku: "claude-opus-4.5", product: "copilot_agent" },
      ]
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 18)
      assert.equal(result!.byModel["claude-opus-4.5"], 13)
      assert.equal(result!.byModel["gpt-5.4-mini"], 5)
      assert.equal(result!.monthlyAllowance, 300)
      assert.equal(result!.remaining, 282)
      assert.equal(result!.percentUsed, 6)
    })

    it("parses object response with usageItems field", () => {
      const data = {
        usageItems: [
          { quantity: 50, sku: "claude-opus-4.5", product: "copilot_chat" },
        ],
      }
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 50)
    })

    it("parses object response with usage_items field (snake_case)", () => {
      const data = {
        usage_items: [
          { quantity: 25, sku: "gpt-5.4-mini", product: "copilot_chat" },
        ],
      }
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 25)
    })

    it("handles empty array", () => {
      const result = parsePremiumRequestResponse([], config)
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 0)
      assert.equal(result!.remaining, 300)
    })

    it("handles null gracefully", () => {
      const result = parsePremiumRequestResponse(null, config)
      // null input results in 0 total (empty parse), not null — the function is lenient
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 0)
    })

    it("handles summary object with totalPremiumRequests", () => {
      const data = { totalPremiumRequests: 150 }
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 150)
      assert.equal(result!.remaining, 150)
    })

    it("handles summary object with total_premium_requests (snake_case)", () => {
      const data = { total_premium_requests: 200 }
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 200)
    })

    it("uses plan-based allowance", () => {
      const proPlus: PluginConfig = { ...config, copilot_plan: "pro+" }
      const data = [{ quantity: 100, sku: "test", product: "test" }]
      const result = parsePremiumRequestResponse(data, proPlus)
      assert.notEqual(result, null)
      assert.equal(result!.monthlyAllowance, 1500) // pro+ = 1500
      assert.equal(result!.remaining, 1400)
    })

    it("calculates percentUsed correctly", () => {
      const data = [{ quantity: 150, sku: "test", product: "test" }]
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.percentUsed, 50) // 150/300 = 50%
    })

    it("groups by model and product", () => {
      const data = [
        { quantity: 10, sku: "model-a", product: "chat" },
        { quantity: 20, sku: "model-b", product: "chat" },
        { quantity: 5, sku: "model-a", product: "agent" },
      ]
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.byModel["model-a"], 15) // 10 + 5
      assert.equal(result!.byModel["model-b"], 20)
      assert.equal(result!.byProduct["chat"], 30) // 10 + 20
      assert.equal(result!.byProduct["agent"], 5)
    })

    it("handles items with missing fields", () => {
      const data = [
        { quantity: 10 }, // missing sku and product
        { sku: "test" }, // missing quantity
      ]
      const result = parsePremiumRequestResponse(data, config)
      assert.notEqual(result, null)
      assert.equal(result!.totalPremiumRequests, 10) // only first has quantity
    })
  })

  describe("formatPremiumRequestStatus", () => {
    it("formats basic status line", () => {
      const result = formatPremiumRequestStatus({
        totalPremiumRequests: 150,
        byModel: {},
        byProduct: {},
        monthlyAllowance: 300,
        remaining: 150,
        percentUsed: 50,
        fetchedAt: "2026-03-21T10:00:00Z",
      })
      assert(result.includes("150 / 300"))
      assert(result.includes("50% used"))
      assert(result.includes("150 remaining"))
    })

    it("includes model breakdown", () => {
      const result = formatPremiumRequestStatus({
        totalPremiumRequests: 100,
        byModel: { "claude-opus-4.5": 60, "gpt-5.4-mini": 40 },
        byProduct: {},
        monthlyAllowance: 300,
        remaining: 200,
        percentUsed: 33,
        fetchedAt: "2026-03-21T10:00:00Z",
      })
      assert(result.includes("claude-opus-4.5: 60 requests"))
      assert(result.includes("gpt-5.4-mini: 40 requests"))
    })
  })
})
