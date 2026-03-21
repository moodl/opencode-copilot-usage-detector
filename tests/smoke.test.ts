import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("smoke test", () => {
  it("should run tests", () => {
    assert.equal(1 + 1, 2)
  })
})
