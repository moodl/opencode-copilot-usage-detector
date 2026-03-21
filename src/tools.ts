import { tool } from "@opencode-ai/plugin/tool"
import { getDaily, getCurrentRPM } from "./aggregator.js"
import { readObservations, readEstimates, getDataDir, readConfig } from "./persistence.js"
import { getBudgetStatus, computeEstimates } from "./estimator.js"
import { pollPremiumRequests, getCachedPremiumRequests, getApiStatus, formatPremiumRequestStatus } from "./github-api.js"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

export function formatStatus(): string {
  const d = getDaily()
  const rpm = getCurrentRPM()
  const config = readConfig()
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

  // Premium requests from GitHub API
  const pr = getCachedPremiumRequests()

  const lines: string[] = [
    `## Copilot Budget Status — ${d.date}`,
    "",
  ]

  if (pr) {
    lines.push("### Monthly Premium Requests")
    lines.push("")
    lines.push(formatPremiumRequestStatus(pr))
    lines.push(`*Last updated: ${pr.fetchedAt}*`)
    lines.push("")
  } else {
    const apiSt = getApiStatus()
    if (apiSt.authMethod === "none" && apiSt.lastError) {
      lines.push(`*Premium request API: ${apiSt.lastError}*`)
      lines.push("")
    }
  }

  lines.push(
    `**Total tokens today:** ${formatTokens(d.totalTokens)}`,
    `**Total requests today:** ${d.totalRequests}`,
    `**Total cost today:** $${d.totalCost.toFixed(4)}`,
    `**Current RPM:** ${rpm} req/min (peak: ${d.peakRPM})`,
    "",
  )

  // Estimates
  if (status.estimatedTokenLimit) {
    const confStr = Math.round(status.confidence * 100)
    lines.push(`**Estimated daily token limit:** ~${formatTokens(status.estimatedTokenLimit)} (${confStr}% confidence)`)
    if (status.percentage !== null) {
      lines.push(`**Usage:** ~${status.percentage}%`)
    }
    lines.push(`**Limit type:** ${status.activeLimitType}`)
    lines.push("")
  } else {
    lines.push("**Estimated daily limit:** Still learning (no limit hits observed yet)")
    lines.push("")
  }

  if (status.estimatedRequestLimit) {
    lines.push(`**Estimated daily request limit:** ~${status.estimatedRequestLimit}`)
    lines.push("")
  }

  // Model breakdown
  const models = Object.entries(d.byModel)
  if (models.length > 0) {
    lines.push("### Model Breakdown")
    lines.push("")
    lines.push("| Model | Tokens | Requests | Category |")
    lines.push("|-------|--------|----------|----------|")

    let estimates: any = null
    try { estimates = readEstimates() } catch { /* */ }

    for (const [model, usage] of models.sort((a, b) => b[1].tokens - a[1].tokens)) {
      const cat = estimates?.models?.[model]?.category ?? "unknown"
      lines.push(`| ${model} | ${formatTokens(usage.tokens)} | ${usage.requests} | ${cat} |`)
    }
    lines.push("")
  }

  // Preview warnings
  if (status.previewWarnings) {
    lines.push("### Preview Model Warnings")
    lines.push("")
    lines.push(status.previewWarnings)
    lines.push("")
  }

  // Limit hits
  if (d.limitHits.length > 0) {
    lines.push(`### Limit Hits Today: ${d.limitHits.length}`)
    lines.push("")
    for (const hit of d.limitHits) {
      lines.push(
        `- **${hit.ts.split("T")[1]?.split(".")[0] ?? hit.ts}** — ${hit.model} (class: ${hit.class}, tokens: ${formatTokens(hit.tokensAtHit)}, requests: ${hit.requestsAtHit}, RPM: ${hit.rpmAtHit})`
      )
    }
    lines.push("")
  }

  // Insights
  if (status.insights) {
    lines.push("### Insights")
    lines.push("")
    lines.push(status.insights)
    lines.push("")
  }

  lines.push(`*Data dir: ${getDataDir()}*`)
  return lines.join("\n")
}

export function formatHistory(days: number): string {
  const dayEnds = readObservations({ type: "day_end" })
  const recent = dayEnds.slice(-days)

  if (recent.length === 0) {
    return "No history yet. Keep using OpenCode and data will accumulate."
  }

  const lines: string[] = [
    `## Usage History (last ${days} days)`,
    "",
    "| Date | Tokens | Requests | Limit Hit |",
    "|------|--------|----------|-----------|",
  ]

  for (const e of recent) {
    if (e.type !== "day_end") continue
    const date = e.ts.split("T")[0]
    lines.push(
      `| ${date} | ${formatTokens(e.day_cumulative_tokens)} | ${e.day_cumulative_requests} | ${e.limit_hit ? "Yes" : "No"} |`
    )
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
    lines.push(`## Rate Limit Events (${recent.length} of ${limitHits.length} total)`)
    lines.push("")

    for (const e of recent) {
      if (e.type !== "limit_hit") continue
      const finalClass = reclassMap.get(e.ts) ?? e.class
      lines.push(`### ${e.ts}`)
      lines.push(`- **Model:** ${e.model}`)
      lines.push(`- **Class:** ${e.class}${finalClass !== e.class ? ` -> ${finalClass}` : ""}`)
      lines.push(`- **Status:** ${e.status_code ?? "unknown"}`)
      lines.push(`- **Message:** ${e.error_message}`)
      lines.push(`- **Retryable:** ${e.is_retryable}`)
      lines.push(`- **Day totals at hit:** ${formatTokens(e.day_cumulative_tokens)} tokens, ${e.day_cumulative_requests} requests, ${e.requests_last_minute} RPM`)
      if (e.response_headers) {
        const rateLimitHeaders = Object.entries(e.response_headers)
          .filter(([k]) => k.toLowerCase().includes("rate") || k.toLowerCase().includes("retry"))
        if (rateLimitHeaders.length > 0) {
          lines.push(`- **Rate-limit headers:**`)
          for (const [k, v] of rateLimitHeaders) {
            lines.push(`  - ${k}: ${v}`)
          }
        }
      }
      lines.push("")
    }
  }

  // Other logged errors
  if (errorLogs.length > 0) {
    const recent = errorLogs.slice(-10)
    lines.push(`## Other Errors (${recent.length} of ${errorLogs.length} total)`)
    lines.push("")
    for (const e of recent) {
      if (e.type !== "error_logged") continue
      lines.push(`- **${e.ts}** — ${e.error_name}: ${e.error_message} (model: ${e.model}, status: ${e.status_code ?? "?"})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

export function formatInsights(): string {
  const config = readConfig()
  const estimates = computeEstimates(
    config.known_preview_models,
    config.known_stable_models,
    config.premium_request_multipliers
  )

  const lines: string[] = [
    "## Copilot Budget Insights",
    "",
    `**Data since:** ${estimates.dataSince.split("T")[0]}`,
    `**Days observed:** ${estimates.totalDaysObserved}`,
    `**Days with limit hit:** ${estimates.daysWithLimitHit}`,
    "",
  ]

  // Global budget
  const te = estimates.globalDailyBudget.tokenEstimate
  if (te.dataPoints > 0) {
    lines.push("### Global Daily Budget")
    lines.push(`- Token estimate: ~${formatTokens(te.value)} (+/- ${formatTokens(te.stdDev)})`)
    lines.push(`- Confidence: ${Math.round(te.confidence * 100)}% (${te.dataPoints} data points)`)
    lines.push(`- Active limit type: ${estimates.globalDailyBudget.activeLimitType}`)
    lines.push("")
  }

  // Request frequency
  if (estimates.requestFrequency.burstLimitEstimate) {
    const be = estimates.requestFrequency.burstLimitEstimate
    lines.push("### Burst (RPM) Limit")
    lines.push(`- Estimated: ~${Math.round(be.value)} req/min`)
    lines.push(`- Confidence: ${Math.round(be.confidence * 100)}% (${be.dataPoints} data points)`)
    lines.push("")
  }

  // Per-model estimates
  const modelEntries = Object.entries(estimates.models)
  if (modelEntries.length > 0) {
    lines.push("### Model Categories")
    lines.push("")
    lines.push("| Model | Category | Source | Confidence | Own Limit | Errors |")
    lines.push("|-------|----------|--------|------------|-----------|--------|")
    for (const [model, est] of modelEntries) {
      const ownLimit = est.ownLimit ? `~${formatTokens(est.ownLimit.value)}` : "-"
      lines.push(`| ${model} | ${est.category} | ${est.categorySource} | ${Math.round(est.categoryConfidence * 100)}% | ${ownLimit} | ${est.totalErrors} |`)
    }
    lines.push("")
  }

  // Temporal patterns
  if (estimates.temporalPatterns.typicalLimitTime) {
    lines.push("### Temporal Patterns")
    lines.push(`- Typical limit time: ${estimates.temporalPatterns.typicalLimitTime}`)
    if (estimates.temporalPatterns.typicalLimitTimeStdDevMinutes) {
      lines.push(`- Std dev: +/- ${Math.round(estimates.temporalPatterns.typicalLimitTimeStdDevMinutes)} min`)
    }
    lines.push(`- Reset type: ${estimates.temporalPatterns.resetHypothesis.type}`)
    if (estimates.temporalPatterns.resetHypothesis.estimatedResetTime) {
      lines.push(`- Estimated reset: ${estimates.temporalPatterns.resetHypothesis.estimatedResetTime}`)
    }
    lines.push("")
  }

  // Multiplier hypothesis
  if (estimates.multiplierHypothesis.rawTokens.observations > 0) {
    lines.push("### Multiplier Hypothesis")
    lines.push(`- Active: ${estimates.multiplierHypothesis.activeHypothesis}`)
    lines.push(`- Raw tokens fit: ${estimates.multiplierHypothesis.rawTokens.fitScore.toFixed(3)}`)
    lines.push(`- Weighted tokens fit: ${estimates.multiplierHypothesis.weightedTokens.fitScore.toFixed(3)}`)
    lines.push("")
  }

  // Insights
  if (estimates.insights.length > 0) {
    lines.push("### Generated Insights")
    lines.push("")
    for (const insight of estimates.insights) {
      lines.push(`- **[${insight.type}]** ${insight.text} (${Math.round(insight.confidence * 100)}% confidence, ${insight.dataPoints} data points)`)
    }
    lines.push("")
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
        const config = readConfig()
        computeEstimates(
          config.known_preview_models,
          config.known_stable_models,
          config.premium_request_multipliers
        )
        return "Estimates recomputed from observations. Run `/budget insights` to see results."
      }
      default:
        return `Unknown action: ${args.action}`
    }
  },
})
