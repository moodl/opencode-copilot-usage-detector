import { tool } from "@opencode-ai/plugin/tool"
import { getDaily, getCurrentRPM } from "./aggregator.js"
import { readObservations, getDataDir } from "./persistence.js"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatStatus(): string {
  const d = getDaily()
  const rpm = getCurrentRPM()

  const lines: string[] = [
    `## Copilot Budget Status — ${d.date}`,
    "",
    `**Total tokens today:** ${formatTokens(d.totalTokens)}`,
    `**Total requests today:** ${d.totalRequests}`,
    `**Total cost today:** $${d.totalCost.toFixed(4)}`,
    `**Current RPM:** ${rpm} req/min (peak: ${d.peakRPM})`,
    "",
  ]

  const models = Object.entries(d.byModel)
  if (models.length > 0) {
    lines.push("### Model Breakdown")
    lines.push("")
    lines.push("| Model | Tokens | Requests |")
    lines.push("|-------|--------|----------|")
    for (const [model, usage] of models.sort((a, b) => b[1].tokens - a[1].tokens)) {
      lines.push(`| ${model} | ${formatTokens(usage.tokens)} | ${usage.requests} |`)
    }
    lines.push("")
  }

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

  lines.push(`*Data dir: ${getDataDir()}*`)
  return lines.join("\n")
}

function formatHistory(days: number): string {
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

function formatErrors(): string {
  const limitHits = readObservations({ type: "limit_hit" })
  const reclassifications = readObservations({ type: "reclassify" })

  if (limitHits.length === 0) {
    return "No errors logged yet."
  }

  const reclassMap = new Map<string, string>()
  for (const r of reclassifications) {
    if (r.type === "reclassify") {
      reclassMap.set(r.ref_ts, r.new_class)
    }
  }

  const recent = limitHits.slice(-20)
  const lines: string[] = [
    `## Recent Errors (${recent.length} of ${limitHits.length} total)`,
    "",
  ]

  for (const e of recent) {
    if (e.type !== "limit_hit") continue
    const finalClass = reclassMap.get(e.ts) ?? e.class
    lines.push(`### ${e.ts}`)
    lines.push(`- **Model:** ${e.model}`)
    lines.push(`- **Class:** ${e.class}${finalClass !== e.class ? ` → ${finalClass}` : ""}`)
    lines.push(`- **Status:** ${e.status_code ?? "unknown"}`)
    lines.push(`- **Message:** ${e.error_message}`)
    lines.push(`- **Retryable:** ${e.is_retryable}`)
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

  return lines.join("\n")
}

export const budgetTool = tool({
  description:
    "Check your GitHub Copilot token budget status, view usage history, and review errors. Actions: 'status' (current usage), 'history' (daily breakdown), 'errors' (rate limit log).",
  args: {
    action: tool.schema.enum(["status", "history", "errors"]),
  },
  async execute(args) {
    switch (args.action) {
      case "status":
        return formatStatus()
      case "history":
        return formatHistory(14)
      case "errors":
        return formatErrors()
      default:
        return `Unknown action: ${args.action}`
    }
  },
})
