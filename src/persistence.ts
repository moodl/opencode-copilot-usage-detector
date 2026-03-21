import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { ObservationEvent, PluginConfig } from "./types.js"
import { DEFAULT_CONFIG } from "./types.js"

const DATA_DIR = join(homedir(), ".config", "copilot-budget")
const OBSERVATIONS_FILE = join(DATA_DIR, "observations.jsonl")
const ESTIMATES_FILE = join(DATA_DIR, "estimates.json")
const CONFIG_FILE = join(DATA_DIR, "config.json")

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true })
  }
}

// ============================================================
// observations.jsonl
// ============================================================

export function appendObservation(event: ObservationEvent): void {
  ensureDataDir()
  const line = JSON.stringify(event)
  appendFileSync(OBSERVATIONS_FILE, line + "\n")
}

export function readObservations(filter?: {
  since?: string
  type?: string
}): ObservationEvent[] {
  if (!existsSync(OBSERVATIONS_FILE)) return []
  try {
    return readFileSync(OBSERVATIONS_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ObservationEvent)
      .filter((e) => {
        if (filter?.since && e.ts < filter.since) return false
        if (filter?.type && e.type !== filter.type) return false
        return true
      })
  } catch {
    return []
  }
}

export function readTodayObservations(today: string): ObservationEvent[] {
  return readObservations({ since: today + "T00:00:00" })
}

// ============================================================
// estimates.json
// ============================================================

export function readEstimates(): Record<string, unknown> | null {
  if (!existsSync(ESTIMATES_FILE)) return null
  try {
    return JSON.parse(readFileSync(ESTIMATES_FILE, "utf-8")) as Record<string, unknown>
  } catch {
    return null
  }
}

export function writeEstimates(data: Record<string, unknown>): void {
  ensureDataDir()
  writeFileSync(ESTIMATES_FILE, JSON.stringify(data, null, 2) + "\n")
}

// ============================================================
// config.json
// ============================================================

export function readConfig(): PluginConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<PluginConfig>
    return { ...DEFAULT_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function getDataDir(): string {
  return DATA_DIR
}
