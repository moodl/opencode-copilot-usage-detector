import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEBUG_FILE = join(homedir(), ".config", "copilot-budget", "debug-events.jsonl")

// Set to true to enable debug logging of ALL events
// Controlled via config.json: { "debug": true }
let enabled = false

export function enableDebug(): void {
  enabled = true
}

export function isDebugEnabled(): boolean {
  return enabled
}

/** Reset debug state. For testing only. */
export function resetDebug(): void {
  enabled = false
}

export function debugLogEvent(type: string, data: unknown): void {
  if (!enabled) return
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      data,
    })
    appendFileSync(DEBUG_FILE, line + "\n")
  } catch {
    // Debug logging must never fail loudly
  }
}

export function debugLogChatParams(
  model: unknown,
  provider: unknown,
): void {
  if (!enabled) return
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type: "chat.params",
      model,
      provider,
    })
    appendFileSync(DEBUG_FILE, line + "\n")
  } catch {
    // Debug logging must never fail loudly
  }
}
