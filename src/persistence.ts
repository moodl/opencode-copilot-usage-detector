import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { ObservationEvent, PluginConfig } from "./types.js"
import { DEFAULT_CONFIG } from "./types.js"
import { debugLogError } from "./debug.js"

function hasField<K extends string>(obj: object, key: K): obj is Record<K, unknown> {
  return key in obj
}

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
  } catch (e) {
    debugLogError("persistence.ensureDataDir", e)
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
  } catch (e) {
    debugLogError("persistence.appendObservation", e)
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
  } catch (e) {
    debugLogError("persistence.readObservations", e)
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

        // Write recent events to temp file, then swap with rollback on failure
        const recentContent = recent.map((e) => JSON.stringify(e)).join("\n") + "\n"
        const tempPath = OBSERVATIONS_FILE + ".tmp"
        writeFileSync(tempPath, recentContent)

        const archivePath = safeArchivePath("archive")
        renameSync(OBSERVATIONS_FILE, archivePath)
        try {
          renameSync(tempPath, OBSERVATIONS_FILE)
        } catch (e) {
          debugLogError("persistence.maybeRotateJsonl.swapTemp", e)
          // Rollback: restore original from archive
          try { renameSync(archivePath, OBSERVATIONS_FILE) } catch { /* best effort */ }
        }
      }
    }
  } catch (e) {
    debugLogError("persistence.maybeRotateJsonl", e)
  }
}

function safeArchivePath(reason: string): string {
  // Use full ISO timestamp (colons replaced for filesystem safety) to avoid collisions
  const ts = new Date().toISOString().replace(/:/g, "-")
  let path = join(DATA_DIR, `observations.${ts}.${reason}.jsonl`)
  // If somehow exists (very unlikely with millisecond timestamps), add a counter
  let counter = 1
  while (existsSync(path)) {
    path = join(DATA_DIR, `observations.${ts}.${reason}.${counter}.jsonl`)
    counter++
  }
  return path
}

function rotateJsonl(reason: string): void {
  try {
    const archivePath = safeArchivePath(reason)
    renameSync(OBSERVATIONS_FILE, archivePath)
  } catch (e) {
    debugLogError("persistence.rotateJsonl", e)
  }
}

// ============================================================
// estimates.json
// ============================================================

export function readEstimates(): Record<string, unknown> | null {
  if (!existsSync(ESTIMATES_FILE)) return null
  try {
    return JSON.parse(readFileSync(ESTIMATES_FILE, "utf-8")) as Record<string, unknown>
  } catch (e) {
    debugLogError("persistence.readEstimates", e)
    return null
  }
}

export function writeEstimates(data: Record<string, unknown> | object): void {
  if (!writable) return
  try {
    ensureDataDir()
    writeFileSync(ESTIMATES_FILE, JSON.stringify(data, null, 2) + "\n")
  } catch (e) {
    debugLogError("persistence.writeEstimates", e)
  }
}

// ============================================================
// config.json
// ============================================================

function validateConfig(raw: Record<string, unknown>): { config: Partial<PluginConfig>; warnings: string[] } {
  const warnings: string[] = []
  const config: Record<string, unknown> = {}

  const typeChecks: Record<string, string> = {
    debug: "boolean",
    timezone: "string",
    quiet_mode: "boolean",
  }

  const arrayChecks = ["known_preview_models", "known_stable_models", "notification_thresholds"]
  const objectChecks = ["premium_request_multipliers"]

  for (const [key, expectedType] of Object.entries(typeChecks)) {
    if (key in raw) {
      if (typeof raw[key] !== expectedType) {
        warnings.push(`config.${key} should be ${expectedType}, got ${typeof raw[key]}`)
      } else {
        config[key] = raw[key]
      }
    }
  }

  for (const key of arrayChecks) {
    if (key in raw) {
      if (!Array.isArray(raw[key])) {
        warnings.push(`config.${key} should be an array`)
      } else {
        config[key] = raw[key]
      }
    }
  }

  for (const key of objectChecks) {
    if (key in raw) {
      if (typeof raw[key] !== "object" || raw[key] === null || Array.isArray(raw[key])) {
        warnings.push(`config.${key} should be an object`)
      } else {
        config[key] = raw[key]
      }
    }
  }

  // Warn on unknown keys
  const knownKeys = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      warnings.push(`unknown config key: "${key}"`)
    }
  }

  return { config: config as Partial<PluginConfig>, warnings }
}

export function readConfig(): { config: PluginConfig; warnings: string[] } {
  if (!existsSync(CONFIG_FILE)) return { config: { ...DEFAULT_CONFIG }, warnings: [] }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>
    const { config, warnings } = validateConfig(raw)
    return { config: { ...DEFAULT_CONFIG, ...config }, warnings }
  } catch (e) {
    debugLogError("persistence.readConfig", e)
    return { config: { ...DEFAULT_CONFIG }, warnings: ["config.json: failed to parse JSON"] }
  }
}

export function getDataDir(): string {
  return DATA_DIR
}

// ============================================================
// Reset / Clean operations
// ============================================================

/** Remove all observations from today, keeping older days intact. */
export function clearTodayObservations(today: string): number {
  if (!existsSync(OBSERVATIONS_FILE)) return 0
  try {
    const all = readObservations()
    const todayPrefix = today + "T"
    const kept = all.filter((e) => !e.ts.startsWith(todayPrefix))
    const removed = all.length - kept.length

    if (removed > 0) {
      const content = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : "")
      const tempPath = OBSERVATIONS_FILE + ".tmp"
      writeFileSync(tempPath, content)
      renameSync(tempPath, OBSERVATIONS_FILE)
    }
    return removed
  } catch (e) {
    debugLogError("persistence.clearTodayObservations", e)
    return 0
  }
}

/** Remove observations matching a filter. Returns count of removed entries. */
export function removeObservations(filter: {
  type?: string
  model?: string
  before?: string
  after?: string
  class?: string
  predicate?: (e: ObservationEvent) => boolean
}): number {
  if (!existsSync(OBSERVATIONS_FILE)) return 0
  try {
    const all = readObservations()
    const kept = all.filter((e) => {
      if (filter.predicate && filter.predicate(e)) return false
      if (filter.type && e.type === filter.type) return false
      if (filter.before && e.ts < filter.before) return false
      if (filter.after && e.ts > filter.after) return false
      if (filter.model && hasField(e, "model") && e.model === filter.model) return false
      if (filter.class && hasField(e, "class") && e.class === filter.class) return false
      return true
    })
    const removed = all.length - kept.length

    if (removed > 0) {
      const content = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : "")
      const tempPath = OBSERVATIONS_FILE + ".tmp"
      writeFileSync(tempPath, content)
      renameSync(tempPath, OBSERVATIONS_FILE)
    }
    return removed
  } catch (e) {
    debugLogError("persistence.removeObservations", e)
    return 0
  }
}

/** Delete estimates.json to force fresh recomputation. */
export function clearEstimates(): void {
  try {
    if (existsSync(ESTIMATES_FILE)) unlinkSync(ESTIMATES_FILE)
  } catch (e) {
    debugLogError("persistence.clearEstimates", e)
  }
}

// ============================================================
// Factory for custom data directory (for testing)
// ============================================================

export interface PersistenceInstance {
  ensureDataDir(): void
  appendObservation(event: ObservationEvent): void
  readObservations(filter?: { since?: string; type?: string }): ObservationEvent[]
  readTodayObservations(today: string): ObservationEvent[]
  readEstimates(): Record<string, unknown> | null
  writeEstimates(data: Record<string, unknown> | object): void
  readConfig(): PluginConfig
  getDataDir(): string
}

export function createPersistence(dataDir: string): PersistenceInstance {
  const obsFile = join(dataDir, "observations.jsonl")
  const estFile = join(dataDir, "estimates.json")
  const cfgFile = join(dataDir, "config.json")

  return {
    ensureDataDir() {
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true })
      }
    },

    appendObservation(event: ObservationEvent) {
      this.ensureDataDir()
      appendFileSync(obsFile, JSON.stringify(event) + "\n")
    },

    readObservations(filter?: { since?: string; type?: string }): ObservationEvent[] {
      if (!existsSync(obsFile)) return []
      try {
        return readFileSync(obsFile, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ObservationEvent)
          .filter((e) => {
            if (filter?.since && e.ts < filter.since) return false
            if (filter?.type && e.type !== filter.type) return false
            return true
          })
      } catch (e) {
        debugLogError("persistence.factory.readObservations", e)
        return []
      }
    },

    readTodayObservations(today: string): ObservationEvent[] {
      return this.readObservations({ since: today + "T00:00:00" })
    },

    readEstimates(): Record<string, unknown> | null {
      if (!existsSync(estFile)) return null
      try {
        return JSON.parse(readFileSync(estFile, "utf-8"))
      } catch (e) {
        debugLogError("persistence.factory.readEstimates", e)
        return null
      }
    },

    writeEstimates(data: Record<string, unknown> | object) {
      this.ensureDataDir()
      writeFileSync(estFile, JSON.stringify(data, null, 2) + "\n")
    },

    readConfig(): PluginConfig {
      if (!existsSync(cfgFile)) return { ...DEFAULT_CONFIG }
      try {
        const raw = JSON.parse(readFileSync(cfgFile, "utf-8")) as Partial<PluginConfig>
        return { ...DEFAULT_CONFIG, ...raw }
      } catch (e) {
        debugLogError("persistence.factory.readConfig", e)
        return { ...DEFAULT_CONFIG }
      }
    },

    getDataDir() {
      return dataDir
    },
  }
}
