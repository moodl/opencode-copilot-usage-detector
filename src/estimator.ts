import type {
  LimitHitEvent,
  ReclassifyEvent,
  ObservationEvent,
  LimitClass,
} from "./types.js"
import { readObservations, readEstimates, writeEstimates } from "./persistence.js"
import { formatTokens } from "./format.js"
import { debugLogError } from "./debug.js"

// ============================================================
// Constants
// ============================================================

const DECAY_HALF_LIFE_DAYS = 14
const DECAY_MAX_DAYS = 60 // Beyond this, confidence drops to minimum

// ============================================================
// Core estimation types
// ============================================================

export interface LimitEstimate {
  value: number
  stdDev: number
  dataPoints: number
  confidence: number
  lastHit: string | null
}

export interface DimensionHypothesis {
  fitScore: number
  observations: number
  values: number[]
}

export interface ModelEstimate {
  category: "stable" | "preview" | "unknown"
  categorySource: "auto" | "config"
  categoryConfidence: number
  categoryReason: string | null
  ownLimit: LimitEstimate | null
  contributesToGlobal: boolean
  avgTokensPerDay: number
  totalErrors: number
  errorsDaily: number
  errorsPreview: number
  errorsBurst: number
  isBlocked: boolean
  blockedSince: string | null
}

export interface Estimates {
  version: number
  lastUpdated: string
  dataSince: string
  totalDaysObserved: number
  daysWithLimitHit: number

  globalDailyBudget: {
    tokenEstimate: LimitEstimate
    requestEstimate: LimitEstimate
    activeLimitType: "tokens" | "requests" | "unknown"
    contributingModels: string[]
  }

  requestFrequency: {
    avgRequestsPerDay: number
    peakRPM: number
    burstLimitEstimate: LimitEstimate | null
  }

  models: Record<string, ModelEstimate>

  multiplierHypothesis: {
    rawTokens: DimensionHypothesis
    weightedTokens: DimensionHypothesis
    activeHypothesis: "raw" | "weighted"
  }

  temporalPatterns: {
    typicalLimitTime: string | null
    typicalLimitTimeStdDevMinutes: number | null
    resetHypothesis: {
      type: "daily_fixed" | "rolling" | "unknown"
      estimatedResetTime: string | null
      confidence: number
    }
  }

  insights: Array<{
    type: string
    text: string
    confidence: number
    dataPoints: number
    firstObserved: string
  }>
}

// ============================================================
// Helpers
// ============================================================

function daysAgo(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000)
}

function exponentialWeight(daysAgo: number): number {
  return Math.exp(-daysAgo * Math.LN2 / DECAY_HALF_LIFE_DAYS)
}

export function weightedMean(values: number[], weights: number[]): number {
  let sumW = 0
  let sumWV = 0
  for (let i = 0; i < values.length; i++) {
    sumW += weights[i]
    sumWV += weights[i] * values[i]
  }
  return sumW > 0 ? sumWV / sumW : 0
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function baseConfidence(dataPoints: number): number {
  if (dataPoints <= 0) return 0
  if (dataPoints === 1) return 0.4
  if (dataPoints === 2) return 0.55
  if (dataPoints <= 4) return 0.7
  if (dataPoints <= 6) return 0.85
  return 0.95
}

export function confidenceWithDecay(dataPoints: number, daysSinceLastHit: number): number {
  const base = baseConfidence(dataPoints)
  if (!isFinite(daysSinceLastHit) || daysSinceLastHit > DECAY_MAX_DAYS) {
    return base * 0.3
  }
  const decayFactor = Math.max(0.3, 1.0 - daysSinceLastHit / DECAY_MAX_DAYS)
  return base * decayFactor
}

function emptyEstimate(): LimitEstimate {
  return { value: 0, stdDev: 0, dataPoints: 0, confidence: 0, lastHit: null }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function isEstimatesRecord(raw: unknown): raw is Estimates {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    (raw as Record<string, unknown>).version === 1
  )
}

// ============================================================
// Get the final class for a limit_hit event (considering reclassifications)
// ============================================================

function getFinalClass(
  event: LimitHitEvent,
  reclassifications: ReclassifyEvent[]
): LimitClass {
  // Find the last reclassification for this event
  const reclass = reclassifications
    .filter((r) => r.ref_ts === event.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts))
  return reclass.length > 0 ? reclass[reclass.length - 1].new_class : event.class
}

// ============================================================
// Sub-functions for computeEstimates
// ============================================================

function computeGlobalDailyBudget(dailyHits: LimitHitEvent[]): {
  tokenEstimate: LimitEstimate
  requestEstimate: LimitEstimate
  activeLimitType: "tokens" | "requests" | "unknown"
  contributingModels: string[]
} {
  const tokenValues = dailyHits.map((e) => e.day_cumulative_tokens)
  const tokenWeights = dailyHits.map((e) => exponentialWeight(daysAgo(e.ts)))
  const requestValues = dailyHits.map((e) => e.day_cumulative_requests)
  const requestWeights = dailyHits.map((e) => exponentialWeight(daysAgo(e.ts)))

  const lastDailyHit = dailyHits.length > 0 ? dailyHits[dailyHits.length - 1].ts : null
  const daysSinceLastDaily = lastDailyHit ? daysAgo(lastDailyHit) : Infinity

  const tokenEstimate: LimitEstimate =
    tokenValues.length > 0
      ? {
          value: weightedMean(tokenValues, tokenWeights),
          stdDev: stdDev(tokenValues),
          dataPoints: tokenValues.length,
          confidence: confidenceWithDecay(tokenValues.length, daysSinceLastDaily),
          lastHit: lastDailyHit,
        }
      : emptyEstimate()

  const requestEstimate: LimitEstimate =
    requestValues.length > 0
      ? {
          value: weightedMean(requestValues, requestWeights),
          stdDev: stdDev(requestValues),
          dataPoints: requestValues.length,
          confidence: confidenceWithDecay(requestValues.length, daysSinceLastDaily),
          lastHit: lastDailyHit,
        }
      : emptyEstimate()

  // Determine which dimension is more consistent (lower relative variance)
  const tokenCV = tokenEstimate.value > 0 ? tokenEstimate.stdDev / tokenEstimate.value : Infinity
  const requestCV =
    requestEstimate.value > 0 ? requestEstimate.stdDev / requestEstimate.value : Infinity

  const activeLimitType: "tokens" | "requests" | "unknown" =
    tokenEstimate.dataPoints < 2
      ? "unknown"
      : tokenCV < requestCV
        ? "tokens"
        : requestCV < tokenCV
          ? "requests"
          : "unknown"

  // Contributing models for global budget
  const contributingModels = [
    ...new Set(dailyHits.flatMap((e) => [e.model]).filter((m) => m !== "unknown")),
  ]

  return { tokenEstimate, requestEstimate, activeLimitType, contributingModels }
}

function computeRequestFrequency(
  usageEvents: ObservationEvent[],
  limitHits: LimitHitEvent[],
  reclassifications: ReclassifyEvent[],
  totalDaysObserved: number
): {
  avgRequestsPerDay: number
  peakRPM: number
  burstLimitEstimate: LimitEstimate | null
} {
  const avgRequestsPerDay =
    totalDaysObserved > 0
      ? usageEvents.length / totalDaysObserved
      : 0

  const burstHits = limitHits.filter(
    (e) => getFinalClass(e, reclassifications) === "burst_rpm_limit"
  )
  const burstRpmValues = burstHits.map((e) => e.requests_last_minute)
  const lastBurstHit = burstHits.length > 0 ? burstHits[burstHits.length - 1].ts : null
  const daysSinceLastBurst = lastBurstHit ? daysAgo(lastBurstHit) : Infinity

  const burstLimitEstimate: LimitEstimate | null =
    burstRpmValues.length > 0
      ? {
          value: weightedMean(
            burstRpmValues,
            burstHits.map((e) => exponentialWeight(daysAgo(e.ts)))
          ),
          stdDev: stdDev(burstRpmValues),
          dataPoints: burstRpmValues.length,
          confidence: confidenceWithDecay(burstRpmValues.length, daysSinceLastBurst),
          lastHit: lastBurstHit,
        }
      : null

  const peakRPM = burstRpmValues.length > 0 ? Math.max(...burstRpmValues) : 0

  return { avgRequestsPerDay, peakRPM, burstLimitEstimate }
}

function computeModelEstimates(
  allModelNames: Set<string>,
  limitHits: LimitHitEvent[],
  usageEvents: ObservationEvent[],
  blockedEvents: ObservationEvent[],
  reclassifications: ReclassifyEvent[],
  tokenEstimate: LimitEstimate,
  knownPreviewModels: string[],
  knownStableModels: string[]
): Record<string, ModelEstimate> {
  const models: Record<string, ModelEstimate> = {}

  for (const model of allModelNames) {
    const modelHits = limitHits.filter(
      (e) => e.model === model && getFinalClass(e, reclassifications) !== "model_blocked"
    )
    const modelDailyHits = modelHits.filter(
      (e) => getFinalClass(e, reclassifications) === "hard_daily_limit"
    )
    const modelPreviewHits = modelHits.filter(
      (e) => getFinalClass(e, reclassifications) === "preview_limit"
    )
    const modelBurstHits = modelHits.filter(
      (e) => getFinalClass(e, reclassifications) === "burst_rpm_limit"
    )
    const modelUsage = usageEvents.filter(
      (e) => e.type === "usage" && e.model === model
    )

    // Calculate average tokens per day for this model
    const modelDays = new Set(modelUsage.map((e) => e.ts.split("T")[0]))
    const modelTokensTotal = modelUsage.reduce(
      (sum, e) => sum + (e.type === "usage" ? e.input_tokens + e.output_tokens + e.reasoning_tokens + e.cache_read + e.cache_write : 0),
      0
    )
    const avgTokensPerDay = modelDays.size > 0 ? modelTokensTotal / modelDays.size : 0

    // Auto-detect category
    let category: "stable" | "preview" | "unknown" = "unknown"
    let categorySource: "auto" | "config" = "auto"
    let categoryConfidence = 0
    let categoryReason: string | null = null

    // Config override first
    if (knownPreviewModels.includes(model)) {
      category = "preview"
      categorySource = "config"
      categoryConfidence = 1.0
      categoryReason = "manual_config"
    } else if (knownStableModels.includes(model)) {
      category = "stable"
      categorySource = "config"
      categoryConfidence = 1.0
      categoryReason = "manual_config"
    } else if (modelPreviewHits.length >= 2 && tokenEstimate.value > 0) {
      // Auto-detect: if this model's limit hits are at significantly lower tokens than global
      const modelHitTokenMedian = median(modelPreviewHits.map((e) => e.day_cumulative_tokens))
      if (modelHitTokenMedian < tokenEstimate.value * 0.5) {
        category = "preview"
        categoryConfidence = 0.75 + Math.min(0.2, modelPreviewHits.length * 0.05)
        categoryReason = `limit_at_${Math.round(modelHitTokenMedian)}_significantly_below_global_${Math.round(tokenEstimate.value)}`
      }
    } else if (modelDailyHits.length >= 2) {
      category = "stable"
      categoryConfidence = 0.7 + Math.min(0.25, modelDailyHits.length * 0.05)
      categoryReason = "contributes_to_daily_hits"
    } else if (modelUsage.length >= 5 && modelPreviewHits.length === 0) {
      category = "stable"
      categoryConfidence = 0.5
      categoryReason = "no_preview_errors_observed"
    }

    // Own limit estimate (for preview models)
    let ownLimit: LimitEstimate | null = null
    if (category === "preview" && modelPreviewHits.length > 0) {
      const vals = modelPreviewHits.map((e) => e.day_cumulative_tokens)
      const wts = modelPreviewHits.map((e) => exponentialWeight(daysAgo(e.ts)))
      const lastModelHit = modelPreviewHits[modelPreviewHits.length - 1].ts
      ownLimit = {
        value: weightedMean(vals, wts),
        stdDev: stdDev(vals),
        dataPoints: vals.length,
        confidence: confidenceWithDecay(vals.length, daysAgo(lastModelHit)),
        lastHit: lastModelHit,
      }
    }

    // Detect blocked models
    const modelBlockedEvents = blockedEvents.filter(
      (e) => e.type === "model_blocked" && e.model === model
    )
    const isBlocked = modelBlockedEvents.length > 0 && modelUsage.length === 0

    models[model] = {
      category,
      categorySource,
      categoryConfidence,
      categoryReason,
      ownLimit,
      contributesToGlobal: category === "stable" || category === "unknown",
      avgTokensPerDay,
      totalErrors: modelHits.length,
      errorsDaily: modelDailyHits.length,
      errorsPreview: modelPreviewHits.length,
      errorsBurst: modelBurstHits.length,
      isBlocked,
      blockedSince: isBlocked && modelBlockedEvents.length > 0 ? modelBlockedEvents[0].ts : null,
    }
  }

  return models
}

function computeMultiplierHypothesis(
  dailyHits: LimitHitEvent[],
  tokenEstimate: LimitEstimate,
  premiumMultipliers: Record<string, number>
): Estimates["multiplierHypothesis"] {
  const rawTokenFits: number[] = []
  const weightedTokenFits: number[] = []

  if (tokenEstimate.value > 0 && Object.keys(premiumMultipliers).length > 0) {
    for (const hit of dailyHits) {
      const rawError = Math.abs(hit.day_cumulative_tokens - tokenEstimate.value)
      rawTokenFits.push(rawError)

      // Calculate weighted tokens for this hit's day
      // We'd need per-model breakdown which we can approximate
      // For now, just use the multiplier of the model that was active at hit time
      const multiplier = premiumMultipliers[hit.model] ?? 1.0
      const weightedTokens = hit.day_cumulative_tokens * multiplier
      const weightedError = Math.abs(weightedTokens - tokenEstimate.value * multiplier)
      weightedTokenFits.push(weightedError)
    }
  }

  const rawFitScore =
    rawTokenFits.length > 0
      ? 1 / (1 + rawTokenFits.reduce((a, b) => a + b, 0) / rawTokenFits.length / Math.max(1, tokenEstimate.value))
      : 0
  const weightedFitScore =
    weightedTokenFits.length > 0
      ? 1 / (1 + weightedTokenFits.reduce((a, b) => a + b, 0) / weightedTokenFits.length / Math.max(1, tokenEstimate.value))
      : 0

  return {
    rawTokens: {
      fitScore: rawFitScore,
      observations: rawTokenFits.length,
      values: rawTokenFits,
    },
    weightedTokens: {
      fitScore: weightedFitScore,
      observations: weightedTokenFits.length,
      values: weightedTokenFits,
    },
    activeHypothesis: weightedFitScore > rawFitScore ? "weighted" : "raw",
  }
}

function computeTemporalPatterns(
  dailyHits: LimitHitEvent[],
  allObs: ObservationEvent[]
): Estimates["temporalPatterns"] {
  const hitTimes = dailyHits.map((e) => {
    const date = new Date(e.ts)
    return date.getHours() + date.getMinutes() / 60
  })
  const typicalLimitTime =
    hitTimes.length > 0
      ? (() => {
          const avg = hitTimes.reduce((a, b) => a + b, 0) / hitTimes.length
          const hours = Math.floor(avg)
          const mins = Math.round((avg - hours) * 60)
          return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`
        })()
      : null

  const hitTimeStdDev =
    hitTimes.length >= 2 ? stdDev(hitTimes) * 60 : null // in minutes

  // Reset hypothesis from recovery events
  const recoveryEvents = allObs.filter((e) => e.type === "recovery")
  const recoveryTimes = recoveryEvents.map((e) => {
    const date = new Date(e.ts)
    return date.getHours() + date.getMinutes() / 60
  })

  let resetHypothesis: Estimates["temporalPatterns"]["resetHypothesis"] = {
    type: "unknown",
    estimatedResetTime: null,
    confidence: 0,
  }

  if (recoveryTimes.length >= 3) {
    const recoveryStdDev = stdDev(recoveryTimes) * 60 // in minutes
    if (recoveryStdDev < 90) {
      // Recoveries cluster around a time — likely fixed daily reset
      const avgRecoveryHour = recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length
      const hours = Math.floor(avgRecoveryHour)
      const mins = Math.round((avgRecoveryHour - hours) * 60)
      resetHypothesis = {
        type: "daily_fixed",
        estimatedResetTime: `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`,
        confidence: Math.min(0.9, 0.5 + recoveryTimes.length * 0.1),
      }
    } else {
      resetHypothesis = {
        type: "rolling",
        estimatedResetTime: null,
        confidence: 0.4,
      }
    }
  }

  return {
    typicalLimitTime,
    typicalLimitTimeStdDevMinutes: hitTimeStdDev,
    resetHypothesis,
  }
}

function generateInsights(
  models: Record<string, ModelEstimate>,
  dailyHits: LimitHitEvent[],
  tokenEstimate: LimitEstimate,
  blockedEvents: ObservationEvent[]
): Estimates["insights"] {
  const insights: Estimates["insights"] = []

  const hitTimes = dailyHits.map((e) => {
    const date = new Date(e.ts)
    return date.getHours() + date.getMinutes() / 60
  })

  // Insight: model impact on limit time
  if (hitTimes.length >= 5) {
    const hitsByModel = new Map<string, number[]>()
    for (const hit of dailyHits) {
      const date = new Date(hit.ts)
      const hour = date.getHours() + date.getMinutes() / 60
      const arr = hitsByModel.get(hit.model) ?? []
      arr.push(hour)
      hitsByModel.set(hit.model, arr)
    }

    const modelAvgs = [...hitsByModel.entries()]
      .filter(([, times]) => times.length >= 2)
      .map(([model, times]) => ({
        model,
        avg: times.reduce((a, b) => a + b, 0) / times.length,
        count: times.length,
      }))

    if (modelAvgs.length >= 2) {
      modelAvgs.sort((a, b) => a.avg - b.avg)
      const earliest = modelAvgs[0]
      const latest = modelAvgs[modelAvgs.length - 1]
      const diffHours = latest.avg - earliest.avg

      if (diffHours > 1) {
        insights.push({
          type: "model_impact",
          text: `${earliest.model}-heavy days hit limits ~${diffHours.toFixed(1)}h earlier than ${latest.model}-heavy days`,
          confidence: Math.min(0.85, 0.5 + (earliest.count + latest.count) * 0.05),
          dataPoints: earliest.count + latest.count,
          firstObserved: dailyHits[0].ts.split("T")[0],
        })
      }
    }
  }

  // Insight: preview model detection
  for (const [model, est] of Object.entries(models)) {
    if (est.category === "preview" && est.ownLimit && est.categorySource === "auto") {
      insights.push({
        type: "preview_detection",
        text: `${model} has separate preview limit (~${Math.round(est.ownLimit.value / 1000)}K tokens)`,
        confidence: est.categoryConfidence,
        dataPoints: est.errorsPreview,
        firstObserved: est.ownLimit.lastHit?.split("T")[0] ?? new Date().toISOString().split("T")[0],
      })
    }
  }

  // Insight: blocked models
  for (const [model, est] of Object.entries(models)) {
    if (est.isBlocked && est.blockedSince) {
      insights.push({
        type: "model_blocked",
        text: `${model} appears blocked (not available on your plan)`,
        confidence: 0.9,
        dataPoints: blockedEvents.filter((e) => e.type === "model_blocked" && e.model === model).length,
        firstObserved: est.blockedSince.split("T")[0],
      })
    }
  }

  // ---- Anomaly detection ----
  if (tokenEstimate.dataPoints >= 3 && dailyHits.length > 0) {
    const lastHit = dailyHits[dailyHits.length - 1]
    const deviation = Math.abs(lastHit.day_cumulative_tokens - tokenEstimate.value)
    if (deviation > 2 * tokenEstimate.stdDev && tokenEstimate.stdDev > 0) {
      insights.push({
        type: "anomaly",
        text: `Last limit hit at ${Math.round(lastHit.day_cumulative_tokens / 1000)}K tokens deviates from estimate ~${Math.round(tokenEstimate.value / 1000)}K by ${Math.round(deviation / 1000)}K (>${Math.round(2 * tokenEstimate.stdDev / 1000)}K threshold)`,
        confidence: 0.6,
        dataPoints: tokenEstimate.dataPoints,
        firstObserved: lastHit.ts.split("T")[0],
      })
    }
  }

  return insights
}

// ============================================================
// Main estimation function
// ============================================================

export function computeEstimates(
  knownPreviewModels: string[],
  knownStableModels: string[],
  premiumMultipliers: Record<string, number>
): Estimates {
  const allObs = readObservations()

  const limitHits = allObs.filter((e) => e.type === "limit_hit") as LimitHitEvent[]
  const reclassifications = allObs.filter((e) => e.type === "reclassify") as ReclassifyEvent[]
  const usageEvents = allObs.filter((e) => e.type === "usage")
  const blockedEvents = allObs.filter((e) => e.type === "model_blocked")

  // Find earliest observation date
  const dataSince = allObs.length > 0 ? allObs[0].ts : new Date().toISOString()

  // Count unique days
  const uniqueDays = new Set(allObs.map((e) => e.ts.split("T")[0]))
  const totalDaysObserved = uniqueDays.size

  // Days with limit hits
  const daysWithHits = new Set(
    limitHits
      .filter((e) => getFinalClass(e, reclassifications) === "hard_daily_limit")
      .map((e) => e.ts.split("T")[0])
  )

  // Daily limit hits (used by several sub-functions)
  const dailyHits = limitHits.filter(
    (e) => getFinalClass(e, reclassifications) === "hard_daily_limit"
  )

  // Collect all model names
  const allModelNames = new Set<string>()
  for (const e of limitHits) allModelNames.add(e.model)
  for (const e of usageEvents) {
    if (e.type === "usage") allModelNames.add(e.model)
  }
  for (const e of blockedEvents) {
    if (e.type === "model_blocked") allModelNames.add(e.model)
  }
  allModelNames.delete("unknown")

  // Compute each section via sub-functions
  const globalDailyBudget = computeGlobalDailyBudget(dailyHits)
  const requestFrequency = computeRequestFrequency(usageEvents, limitHits, reclassifications, totalDaysObserved)
  const models = computeModelEstimates(
    allModelNames, limitHits, usageEvents, blockedEvents,
    reclassifications, globalDailyBudget.tokenEstimate,
    knownPreviewModels, knownStableModels
  )
  const multiplierHypothesis = computeMultiplierHypothesis(dailyHits, globalDailyBudget.tokenEstimate, premiumMultipliers)
  const temporalPatterns = computeTemporalPatterns(dailyHits, allObs)
  const insights = generateInsights(models, dailyHits, globalDailyBudget.tokenEstimate, blockedEvents)

  const estimates: Estimates = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    dataSince,
    totalDaysObserved,
    daysWithLimitHit: daysWithHits.size,
    globalDailyBudget,
    requestFrequency,
    models,
    multiplierHypothesis,
    temporalPatterns,
    insights,
  }

  // Persist
  writeEstimates(estimates)

  return estimates
}

// ============================================================
// Quick status for system prompt injection
// ============================================================

export interface BudgetStatus {
  todayTokens: number
  todayRequests: number
  todayCost: number
  estimatedTokenLimit: number | null
  estimatedRequestLimit: number | null
  percentage: number | null
  confidence: number
  activeLimitType: string
  modelBreakdown: string
  previewWarnings: string
  insights: string
  limitHitsToday: number
}

export function getBudgetStatus(
  dailyTokens: number,
  dailyRequests: number,
  dailyCost: number,
  dailyByModel: Record<string, { tokens: number; requests: number }>,
  limitHitsToday: number,
  knownPreviewModels: string[],
  knownStableModels: string[],
  premiumMultipliers: Record<string, number>
): BudgetStatus {
  // Try to load cached estimates (don't recompute on every call)
  let estimates: Estimates | null = null
  try {
    const raw = readEstimates()
    if (isEstimatesRecord(raw)) {
      estimates = raw
    }
  } catch (e) {
    debugLogError("estimator.getBudgetStatus", e)
  }

  const tokenLimit = estimates?.globalDailyBudget.tokenEstimate.value ?? null
  const requestLimit = estimates?.globalDailyBudget.requestEstimate.value ?? null
  const confidence = estimates?.globalDailyBudget.tokenEstimate.confidence ?? 0
  const activeLimitType = estimates?.globalDailyBudget.activeLimitType ?? "unknown"

  // Calculate percentage based on active limit type
  let percentage: number | null = null
  if (activeLimitType === "tokens" && tokenLimit && tokenLimit > 0) {
    percentage = Math.round((dailyTokens / tokenLimit) * 100)
  } else if (activeLimitType === "requests" && requestLimit && requestLimit > 0) {
    percentage = Math.round((dailyRequests / requestLimit) * 100)
  } else if (tokenLimit && tokenLimit > 0) {
    percentage = Math.round((dailyTokens / tokenLimit) * 100)
  }

  // Preview warnings
  const previewWarnings: string[] = []
  if (estimates) {
    for (const [model, est] of Object.entries(estimates.models)) {
      if (est.category === "preview" && est.ownLimit) {
        const modelUsage = dailyByModel[model]
        if (modelUsage && est.ownLimit.value > 0) {
          const pct = Math.round((modelUsage.tokens / est.ownLimit.value) * 100)
          if (pct > 70) {
            previewWarnings.push(
              `${model}: ${pct}% of preview limit (~${Math.round(est.ownLimit.value / 1000)}K)`
            )
          }
        }
      }
    }
  }

  // Format insights
  const insightLines: string[] = []
  if (estimates?.insights) {
    for (const insight of estimates.insights.filter((i) => i.confidence > 0.5)) {
      insightLines.push(insight.text)
    }
  }

  return {
    todayTokens: dailyTokens,
    todayRequests: dailyRequests,
    todayCost: dailyCost,
    estimatedTokenLimit: tokenLimit && tokenLimit > 0 ? Math.round(tokenLimit) : null,
    estimatedRequestLimit: requestLimit && requestLimit > 0 ? Math.round(requestLimit) : null,
    percentage,
    confidence,
    activeLimitType,
    modelBreakdown: Object.entries(dailyByModel)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([m, u]) => {
        const cat = estimates?.models[m]?.category ?? "unknown"
        return `  ${m}: ${formatTokens(u.tokens)} tokens / ${u.requests} requests (${cat})`
      })
      .join("\n"),
    previewWarnings: previewWarnings.join("\n"),
    insights: insightLines.join("\n"),
    limitHitsToday,
  }
}

// ============================================================
// Threshold notification check
// ============================================================

export function checkThresholds(
  percentage: number | null,
  thresholds: number[],
  alreadyNotified: Set<number>
): number | null {
  if (percentage === null) return null
  for (const t of [...thresholds].sort((a, b) => a - b)) {
    if (percentage >= t && !alreadyNotified.has(t)) {
      return t
    }
  }
  return null
}
