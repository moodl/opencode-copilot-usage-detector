import { tool } from "@opencode-ai/plugin/tool"
import { getDaily, getCurrentRPM } from "./aggregator.js"
import { readObservations, readConfig } from "./persistence.js"
import { getBudgetStatus, computeEstimates } from "./estimator.js"
import { formatTokens } from "./format.js"

function pad(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length)
}

export function formatStatus(): string {
  const d = getDaily()
  const rpm = getCurrentRPM()
  const { config } = readConfig()
  const status = getBudgetStatus(
    d.totalTokens,
    d.totalRequests,
    d.totalCost,
    d.byModel,
    d.limitHits.length,
    config.known_preview_models,
    config.known_stable_models,
    config.premium_request_multipliers
  )

  const lines: string[] = [
    `Copilot Budget — ${d.date}`,
  ]

  // Daily usage
  lines.push("")
  lines.push(`Tokens today: ${formatTokens(d.totalTokens)} (${d.totalRequests} requests)`)
  lines.push(`RPM: ${rpm} req/min (peak: ${d.peakRPM})`)

  // Estimates
  if (status.estimatedTokenLimit) {
    const confStr = Math.round(status.confidence * 100)
    lines.push(`Estimated limit: ~${formatTokens(status.estimatedTokenLimit)} (${confStr}% confidence)`)
    if (status.percentage !== null) {
      lines.push(`Usage: ~${status.percentage}%`)
    }
  } else {
    lines.push("Estimated limit: still learning")
  }

  if (status.estimatedRequestLimit) {
    lines.push(`Estimated request limit: ~${status.estimatedRequestLimit}`)
  }

  // Model breakdown
  const models = Object.entries(d.byModel)
  if (models.length > 0) {
    lines.push("")
    lines.push("Models:")
    const sorted = models.sort((a, b) => b[1].tokens - a[1].tokens)
    const maxName = Math.max(...sorted.map(([m]) => m.length))
    for (const [model, usage] of sorted) {
      lines.push(`  ${pad(model, maxName)}  ${pad(formatTokens(usage.tokens), 6)}  ${usage.requests} req`)
    }
  }

  // Preview warnings
  if (status.previewWarnings) {
    lines.push("")
    lines.push("Preview warnings:")
    lines.push(status.previewWarnings)
  }

  // Blocked models (skip "unknown" model names)
  const namedBlocked = d.blockedModels.filter((b) => b.model !== "unknown")
  if (namedBlocked.length > 0) {
    const uniqueBlocked = [...new Set(namedBlocked.map((b) => b.model))]
    lines.push("")
    lines.push("Blocked models:")
    for (const model of uniqueBlocked) {
      const first = namedBlocked.find((b) => b.model === model)!
      lines.push(`  ${model} — not available on your plan (status: ${first.statusCode ?? "?"})`)
    }
  }

  // Limit hits
  if (d.limitHits.length > 0) {
    lines.push("")
    lines.push(`Limit hits today: ${d.limitHits.length}`)
    for (const hit of d.limitHits) {
      const time = hit.ts.split("T")[1]?.split(".")[0] ?? hit.ts
      lines.push(`  ${time}  ${hit.model}  ${hit.class}  ${formatTokens(hit.tokensAtHit)} tokens  ${hit.requestsAtHit} req`)
    }
  }

  // Insights
  if (status.insights) {
    lines.push("")
    lines.push("Insights:")
    lines.push(status.insights)
  }

  return lines.join("\n")
}

export function formatHistory(days: number): string {
  const dayEnds = readObservations({ type: "day_end" })
  const recent = dayEnds.slice(-days)

  if (recent.length === 0) {
    return "No history yet. Keep using OpenCode and data will accumulate."
  }

  const lines: string[] = [
    `Usage History (last ${days} days)`,
    "",
  ]

  for (const e of recent) {
    if (e.type !== "day_end") continue
    const date = e.ts.split("T")[0]
    const limit = e.limit_hit ? "limit hit" : ""
    lines.push(`  ${date}  ${pad(formatTokens(e.day_cumulative_tokens), 6)}  ${pad(String(e.day_cumulative_requests) + " req", 8)}  ${limit}`)
  }

  return lines.join("\n")
}

export function formatErrors(): string {
  const limitHits = readObservations({ type: "limit_hit" })
  const reclassifications = readObservations({ type: "reclassify" })
  const errorLogs = readObservations({ type: "error_logged" })

  if (limitHits.length === 0 && errorLogs.length === 0) {
    return "No errors logged yet."
  }

  const reclassMap = new Map<string, string>()
  for (const r of reclassifications) {
    if (r.type === "reclassify") {
      reclassMap.set(r.ref_ts, r.new_class)
    }
  }

  const lines: string[] = []

  // Rate limit events
  if (limitHits.length > 0) {
    const recent = limitHits.slice(-20)
    lines.push(`Rate Limit Events (${recent.length} of ${limitHits.length} total)`)
    lines.push("")

    for (const e of recent) {
      if (e.type !== "limit_hit") continue
      const finalClass = reclassMap.get(e.ts) ?? e.class
      lines.push(e.ts)
      lines.push(`  Model: ${e.model}`)
      lines.push(`  Class: ${e.class}${finalClass !== e.class ? ` -> ${finalClass}` : ""}`)
      lines.push(`  Status: ${e.status_code ?? "unknown"}`)
      lines.push(`  Message: ${e.error_message}`)
      lines.push(`  Retryable: ${e.is_retryable}`)
      lines.push(`  Day totals: ${formatTokens(e.day_cumulative_tokens)} tokens, ${e.day_cumulative_requests} req, ${e.requests_last_minute} RPM`)
      if (e.response_headers) {
        const rateLimitHeaders = Object.entries(e.response_headers)
          .filter(([k]) => k.toLowerCase().includes("rate") || k.toLowerCase().includes("retry"))
        if (rateLimitHeaders.length > 0) {
          lines.push("  Rate-limit headers:")
          for (const [k, v] of rateLimitHeaders) {
            lines.push(`    ${k}: ${v}`)
          }
        }
      }
      lines.push("")
    }
  }

  // Blocked model events
  const blockedLogs = readObservations({ type: "model_blocked" })
  if (blockedLogs.length > 0) {
    const recent = blockedLogs.slice(-10)
    lines.push(`Blocked Models (${recent.length} of ${blockedLogs.length} total)`)
    lines.push("")
    for (const e of recent) {
      if (e.type !== "model_blocked") continue
      lines.push(`  ${e.ts}  ${e.model}: ${e.error_message} (status: ${e.status_code ?? "?"})`)
    }
    lines.push("")
  }

  // Other logged errors
  if (errorLogs.length > 0) {
    const recent = errorLogs.slice(-10)
    lines.push(`Other Errors (${recent.length} of ${errorLogs.length} total)`)
    lines.push("")
    for (const e of recent) {
      if (e.type !== "error_logged") continue
      lines.push(`  ${e.ts}  ${e.error_name}: ${e.error_message} (model: ${e.model}, status: ${e.status_code ?? "?"})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

export function formatInsights(): string {
  const { config } = readConfig()
  const estimates = computeEstimates(
    config.known_preview_models,
    config.known_stable_models,
    config.premium_request_multipliers
  )

  const te = estimates.globalDailyBudget.tokenEstimate
  const hasData = te.dataPoints > 0 || estimates.insights.length > 0

  if (!hasData) {
    return `Copilot Budget Insights\n\nDays observed: ${estimates.totalDaysObserved}\nNo limit hits observed yet — keep using OpenCode and insights will appear as data accumulates.`
  }

  const lines: string[] = [
    "Copilot Budget Insights",
    "",
    `Data since: ${estimates.dataSince.split("T")[0]}`,
    `Days observed: ${estimates.totalDaysObserved}`,
    `Days with limit hit: ${estimates.daysWithLimitHit}`,
  ]

  // Global budget
  if (te.dataPoints > 0) {
    lines.push("")
    lines.push("Global Daily Budget")
    lines.push(`  Token estimate: ~${formatTokens(te.value)} (+/- ${formatTokens(te.stdDev)})`)
    lines.push(`  Confidence: ${Math.round(te.confidence * 100)}% (${te.dataPoints} data points)`)
    lines.push(`  Active limit type: ${estimates.globalDailyBudget.activeLimitType}`)
  }

  // Request frequency
  if (estimates.requestFrequency.burstLimitEstimate) {
    const be = estimates.requestFrequency.burstLimitEstimate
    lines.push("")
    lines.push("Burst (RPM) Limit")
    lines.push(`  Estimated: ~${Math.round(be.value)} req/min`)
    lines.push(`  Confidence: ${Math.round(be.confidence * 100)}% (${be.dataPoints} data points)`)
  }

  // Per-model estimates (skip if all unknown with 0 errors)
  const modelEntries = Object.entries(estimates.models)
    .filter(([, est]) => est.category !== "unknown" || est.totalErrors > 0 || est.ownLimit !== null)
  if (modelEntries.length > 0) {
    lines.push("")
    lines.push("Model Categories")
    const maxName = Math.max(...modelEntries.map(([m]) => m.length))
    for (const [model, est] of modelEntries) {
      const ownLimit = est.ownLimit ? `limit ~${formatTokens(est.ownLimit.value)}` : ""
      lines.push(`  ${pad(model, maxName)}  ${pad(est.category, 7)}  ${est.categorySource}  ${Math.round(est.categoryConfidence * 100)}%  ${est.totalErrors} errors  ${ownLimit}`)
    }
  }

  // Temporal patterns
  if (estimates.temporalPatterns.typicalLimitTime) {
    lines.push("")
    lines.push("Temporal Patterns")
    lines.push(`  Typical limit time: ${estimates.temporalPatterns.typicalLimitTime}`)
    if (estimates.temporalPatterns.typicalLimitTimeStdDevMinutes) {
      lines.push(`  Std dev: +/- ${Math.round(estimates.temporalPatterns.typicalLimitTimeStdDevMinutes)} min`)
    }
    lines.push(`  Reset type: ${estimates.temporalPatterns.resetHypothesis.type}`)
    if (estimates.temporalPatterns.resetHypothesis.estimatedResetTime) {
      lines.push(`  Estimated reset: ${estimates.temporalPatterns.resetHypothesis.estimatedResetTime}`)
    }
  }

  // Multiplier hypothesis
  if (estimates.multiplierHypothesis.rawTokens.observations > 0) {
    lines.push("")
    lines.push("Multiplier Hypothesis")
    lines.push(`  Active: ${estimates.multiplierHypothesis.activeHypothesis}`)
    lines.push(`  Raw tokens fit: ${estimates.multiplierHypothesis.rawTokens.fitScore.toFixed(3)}`)
    lines.push(`  Weighted tokens fit: ${estimates.multiplierHypothesis.weightedTokens.fitScore.toFixed(3)}`)
  }

  // Insights
  if (estimates.insights.length > 0) {
    lines.push("")
    lines.push("Insights")
    for (const insight of estimates.insights) {
      lines.push(`  [${insight.type}] ${insight.text} (${Math.round(insight.confidence * 100)}%, ${insight.dataPoints} data points)`)
    }
  }

  return lines.join("\n")
}

export const budgetTool = tool({
  description:
    "Check your GitHub Copilot token budget status, view usage history, get insights, and review errors. Actions: 'status' (current usage + estimates), 'history' (daily breakdown), 'insights' (learned patterns + estimates), 'errors' (rate limit + error log), 'recompute' (force recompute estimates).",
  args: {
    action: tool.schema.enum(["status", "history", "insights", "errors", "recompute"]),
  },
  async execute(args) {
    switch (args.action) {
      case "status":
        return formatStatus()
      case "history":
        return formatHistory(14)
      case "insights":
        return formatInsights()
      case "errors":
        return formatErrors()
      case "recompute": {
        const { config } = readConfig()
        computeEstimates(
          config.known_preview_models,
          config.known_stable_models,
          config.premium_request_multipliers
        )
        return "Estimates recomputed. Run /budget insights to see results."
      }
      default:
        return `Unknown action: ${args.action}`
    }
  },
})
