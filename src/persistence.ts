import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { ObservationEvent, PluginConfig } from "./types.js"
import { DEFAULT_CONFIG } from "./types.js"

const DATA_DIR = join(homedir(), ".config", "copilot-budget")
const OBSERVATIONS_FILE = join(DATA_DIR, "observations.jsonl")
const ESTIMATES_FILE = join(DATA_DIR, "estimates.json")
const CONFIG_FILE = join(DATA_DIR, "config.json")

const MAX_JSONL_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_JSONL_AGE_DAYS = 90

let writable = true // Track if the data dir is writable

export function ensureDataDir(): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true })
    }
    writable = true
  } catch {
    writable = false
  }
}

export function isWritable(): boolean {
  return writable
}

// ============================================================
// observations.jsonl
// ============================================================

export function appendObservation(event: ObservationEvent): void {
  if (!writable) return
  try {
    ensureDataDir()
    const line = JSON.stringify(event)
    appendFileSync(OBSERVATIONS_FILE, line + "\n")

    // Check if rotation needed
    maybeRotateJsonl()
  } catch {
    // Graceful degradation — don't crash if we can't write
  }
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
// JSONL rotation
// ============================================================

let lastRotationCheck = 0

function maybeRotateJsonl(): void {
  // Only check every 5 minutes
  const now = Date.now()
  if (now - lastRotationCheck < 5 * 60 * 1000) return
  lastRotationCheck = now

  try {
    if (!existsSync(OBSERVATIONS_FILE)) return
    const stats = statSync(OBSERVATIONS_FILE)

    // Rotate by size
    if (stats.size > MAX_JSONL_SIZE_BYTES) {
      rotateJsonl("size_exceeded")
      return
    }

    // Rotate by age: check if the oldest entry is > MAX_JSONL_AGE_DAYS old
    const allObs = readObservations()
    if (allObs.length > 0) {
      const oldest = new Date(allObs[0].ts)
      const ageDays = (Date.now() - oldest.getTime()) / (24 * 60 * 60 * 1000)
      if (ageDays > MAX_JSONL_AGE_DAYS) {
        // Keep last 30 days, archive the rest
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        const recent = allObs.filter((e) => e.ts >= cutoff)

        const archivePath = join(
          DATA_DIR,
          `observations.${new Date().toISOString().split("T")[0]}.archive.jsonl`
        )
        renameSync(OBSERVATIONS_FILE, archivePath)

        // Write back only recent events
        for (const event of recent) {
          appendFileSync(OBSERVATIONS_FILE, JSON.stringify(event) + "\n")
        }
      }
    }
  } catch {
    // Rotation failure is not critical
  }
}

function rotateJsonl(reason: string): void {
  try {
    const archivePath = join(
      DATA_DIR,
      `observations.${new Date().toISOString().split("T")[0]}.${reason}.jsonl`
    )
    renameSync(OBSERVATIONS_FILE, archivePath)
  } catch {
    // Archive failure is not critical
  }
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
  if (!writable) return
  try {
    ensureDataDir()
    writeFileSync(ESTIMATES_FILE, JSON.stringify(data, null, 2) + "\n")
  } catch {
    // Graceful degradation
  }
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
