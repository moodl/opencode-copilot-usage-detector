import type { Plugin } from "@opencode-ai/plugin"
import type {
  Event,
  AssistantMessage,
  EventMessageUpdated,
  EventSessionError,
  ApiError,
} from "@opencode-ai/sdk"
import type { IncomingMessage, IncomingError } from "./aggregator.js"
import {
  recoverFromJSONL,
  processAssistantMessage,
  processErrorEvent,
  getDaily,
  getCurrentRPM,
  setTimezone,
} from "./aggregator.js"
import {
  ensureDataDir,
  readConfig,
  appendObservation,
  readObservations,
  readEstimates,
} from "./persistence.js"
import { budgetTool, formatStatus, formatHistory, formatErrors, formatInsights } from "./tools.js"
import { enableDebug, debugLogEvent, debugLogChatParams } from "./debug.js"
import {
  classifyErrorImmediate,
  extractRateLimitHeaders,
  scheduleReclassification,
} from "./classifier.js"
import { getBudgetStatus, checkThresholds, computeEstimates } from "./estimator.js"
import {
  pollPremiumRequests,
  getCachedPremiumRequests,
  formatPremiumRequestStatus,
} from "./github-api.js"

// ============================================================
// Helpers
// ============================================================

export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

export function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as any).role === "assistant" &&
    typeof (msg as any).id === "string"
  )
}

export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as any).name === "APIError"
  )
}

export function isRateLimitError(error: ApiError): boolean {
  const code = error.data?.statusCode
  const msg = error.data?.message?.toLowerCase() ?? ""
  return (
    code === 429 ||
    msg.includes("rate") ||
    msg.includes("limit") ||
    msg.includes("exceeded") ||
    msg.includes("capacity") ||
    msg.includes("throttl")
  )
}

function readRecentObservations(sinceTs: string) {
  return readObservations({ since: sinceTs })
}

// ============================================================
// Plugin
// ============================================================

const plugin = (async (ctx) => {
  const { client } = ctx

  // Initialize
  ensureDataDir()
  const config = readConfig()
  if (config.debug) {
    enableDebug()
  }
  if (config.timezone) {
    setTimezone(config.timezone)
  }
  recoverFromJSONL()

  // Track the last requested model per session (avoids cross-session contamination)
  const sessionModels = new Map<string, { model: string; provider: string }>()

  function getSessionModel(sessionId: string): { model: string | null; provider: string | null } {
    const entry = sessionModels.get(sessionId)
    return entry ? { model: entry.model, provider: entry.provider } : { model: null, provider: null }
  }

  // Auto-recompute estimates periodically
  let usageEventsSinceRecompute = 0
  const RECOMPUTE_EVERY_N_EVENTS = 50
  let lastRecomputeTime = 0
  const RECOMPUTE_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

  function maybeRecomputeEstimates(force = false): void {
    const now = Date.now()
    if (force || usageEventsSinceRecompute >= RECOMPUTE_EVERY_N_EVENTS || now - lastRecomputeTime > RECOMPUTE_INTERVAL_MS) {
      try {
        computeEstimates(
          config.known_preview_models,
          config.known_stable_models,
          config.premium_request_multipliers
        )
        usageEventsSinceRecompute = 0
        lastRecomputeTime = now
      } catch {
        // Recompute failure is not critical
      }
    }
  }

  // Helper to send a message to the user without triggering a reply
  async function sendMessage(sessionId: string, text: string): Promise<void> {
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true,
          parts: [{ type: "text", text, ignored: true }],
        },
      })
    } catch {
      // Notification failure is not critical
    }
  }

  return {
    // ----------------------------------------------------------
    // Config hook: register /budget command
    // ----------------------------------------------------------
    config: async (opencodeConfig) => {
      opencodeConfig.command ??= {}
      opencodeConfig.command["budget"] = {
        template: "",
        description: "Show Copilot budget status, usage history, and insights",
      }
    },

    // ----------------------------------------------------------
    // Command handler: /budget [subcommand]
    // ----------------------------------------------------------
    "command.execute.before": async (
      input: { command: string; sessionID: string; arguments: string },
      _output: { parts: any[] }
    ) => {
      if (input.command !== "budget") return

      const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
      const subcommand = args[0]?.toLowerCase() || "status"

      let result: string
      switch (subcommand) {
        case "status":
          result = formatStatus()
          break
        case "history":
          result = formatHistory(14)
          break
        case "insights":
          result = formatInsights()
          break
        case "errors":
          result = formatErrors()
          break
        case "recompute":
          computeEstimates(
            config.known_preview_models,
            config.known_stable_models,
            config.premium_request_multipliers
          )
          result = "Estimates recomputed. Run `/budget insights` to see results."
          break
        default:
          result = [
            "## /budget commands",
            "",
            "- `/budget` or `/budget status` — Current usage and estimates",
            "- `/budget history` — Daily usage for the last 14 days",
            "- `/budget insights` — Learned patterns and limit analysis",
            "- `/budget errors` — Rate limit events and error catalog",
            "- `/budget recompute` — Force recompute all estimates",
          ].join("\n")
      }

      await sendMessage(input.sessionID, result)
    },

    // ----------------------------------------------------------
    // Event handler
    // ----------------------------------------------------------
    event: async ({ event }: { event: Event }) => {
      try {
        debugLogEvent(event.type, event)

        // ----- message.updated: extract tokens from assistant messages -----
        if (event.type === "message.updated") {
          const msgEvent = event as EventMessageUpdated
          const msg = msgEvent.properties.info
          if (!isAssistantMessage(msg)) return

          const finished = !!msg.finish
          const tokens = msg.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }

          const sm = getSessionModel(msg.sessionID)
          const incoming: IncomingMessage = {
            messageId: msg.id,
            sessionId: msg.sessionID,
            modelId: msg.modelID ?? sm.model ?? "unknown",
            providerId: msg.providerID ?? sm.provider ?? "unknown",
            tokens: {
              total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
              input: tokens.input,
              output: tokens.output,
              reasoning: tokens.reasoning,
              cache: tokens.cache,
            },
            cost: msg.cost ?? 0,
            finished,
          }

          processAssistantMessage(incoming)
          usageEventsSinceRecompute++
          maybeRecomputeEstimates()

          // Detect silent model fallback
          if (finished && msg.modelID && sm.model && msg.modelID !== sm.model) {
            appendObservation({
              ts: new Date().toISOString(),
              type: "model_fallback",
              requested: sm.model,
              received: msg.modelID,
              day_cumulative_tokens: getDaily().totalTokens,
            })
          }

          // Check threshold notifications
          if (finished && !config.quiet_mode) {
            const d = getDaily()
            const status = getBudgetStatus(
              d.totalTokens, d.totalRequests, d.totalCost, d.byModel,
              d.limitHits.length, config.known_preview_models,
              config.known_stable_models, config.premium_request_multipliers
            )

            const threshold = checkThresholds(
              status.percentage, config.notification_thresholds, d.notifiedThresholds
            )

            if (threshold !== null) {
              d.notifiedThresholds.add(threshold)
              const pctStr = status.percentage !== null ? `${status.percentage}%` : "?"
              const limitStr = status.estimatedTokenLimit
                ? formatTokensShort(status.estimatedTokenLimit) : "unknown"
              const confStr = status.confidence > 0.8 ? ""
                : status.confidence > 0.5 ? " (moderate confidence)" : " (low confidence)"
              await sendMessage(
                msg.sessionID,
                `\u{26A1} **${pctStr} of daily Copilot budget used** (${formatTokensShort(d.totalTokens)} / ~${limitStr} est.)${confStr}`
              )
            }
          }
        }

        // ----- session.error: log all errors, detect rate limits -----
        if (event.type === "session.error") {
          const errEvent = event as EventSessionError
          const error = errEvent.properties.error
          if (!error) return
          const sessionId = errEvent.properties.sessionID
          const errSm = getSessionModel(sessionId ?? "")

          if (isApiError(error)) {
            const apiErr = error
            const rateLimitHeaders = extractRateLimitHeaders(apiErr.data?.responseHeaders)
            const classification = classifyErrorImmediate(
              apiErr.data?.message ?? "", apiErr.data?.statusCode, apiErr.data?.responseHeaders
            )

            if (isRateLimitError(apiErr)) {
              const incomingError: IncomingError = {
                sessionId,
                errorName: apiErr.name,
                errorMessage: apiErr.data?.message ?? "",
                errorRaw: JSON.stringify(apiErr),
                statusCode: apiErr.data?.statusCode,
                isRetryable: apiErr.data?.isRetryable ?? false,
                responseHeaders: apiErr.data?.responseHeaders,
                responseBody: apiErr.data?.responseBody,
              }

              const errorTs = processErrorEvent(incomingError, errSm.model, errSm.provider)
              maybeRecomputeEstimates(true)

              const d = getDaily()
              if (d.limitHits.length > 0) {
                d.limitHits[d.limitHits.length - 1].class = classification.class
              }

              // Schedule delayed reclassification (10 min after event)
              scheduleReclassification(errorTs, () => {
                const current = getDaily()
                const recentObs = readRecentObservations(errorTs)
                const errorModel = errSm.model ?? "unknown"
                const otherModels = recentObs
                  .filter((o): o is import("./types.js").UsageEvent => o.type === "usage" && o.model !== errorModel)
                  .map((o) => o.model)
                const uniqueOtherModels = [...new Set(otherModels)]
                const totalRecent = recentObs.length
                const errorRecent = recentObs.filter((o) => o.type === "limit_hit").length
                const recoveryEvent = recentObs.find((o) => o.type === "recovery")
                const recoveryMinutes = recoveryEvent
                  ? (new Date(recoveryEvent.ts).getTime() - new Date(errorTs).getTime()) / 60_000
                  : null

                return {
                  recentObservations: recentObs.map((o) => ({
                    type: o.type,
                    model: "model" in o ? String((o as unknown as Record<string, unknown>).model) : undefined,
                    ts: o.ts,
                  })),
                  dailyTokens: current.totalTokens,
                  dailyRequests: current.totalRequests,
                  globalEstimate: (() => {
                    try {
                      const est = readEstimates()
                      if (est && typeof est === "object") {
                        const gdb = (est as Record<string, unknown>).globalDailyBudget
                        if (gdb && typeof gdb === "object") {
                          const te = (gdb as Record<string, unknown>).tokenEstimate
                          if (te && typeof te === "object") {
                            const val = (te as Record<string, unknown>).value
                            return typeof val === "number" ? val : null
                          }
                        }
                      }
                      return null
                    } catch { return null }
                  })(),
                  otherModelsWorking: uniqueOtherModels.length > 0,
                  workingModels: uniqueOtherModels,
                  errorRate: totalRecent > 0 ? errorRecent / totalRecent : 0,
                  minutesSinceError: (Date.now() - new Date(errorTs).getTime()) / 60_000,
                  hasRecovered: !!recoveryEvent,
                  recoveryMinutes,
                }
              })

              // Notify user
              if (sessionId) {
                const headerInfo = rateLimitHeaders
                  ? ` | Headers: ${Object.entries(rateLimitHeaders.all).map(([k, v]) => `${k}=${v}`).join(", ")}`
                  : ""
                await sendMessage(
                  sessionId,
                  `\u{1F534} **Rate limited!** Day total: ${formatTokensShort(d.totalTokens)} tokens, ${d.totalRequests} requests | Model: ${errSm.model ?? "unknown"} | Status: ${apiErr.data?.statusCode ?? "unknown"} | Class: ${classification.class}${headerInfo}\n\nRun \`/budget errors\` for details.`
                )
              }
            } else {
              appendObservation({
                ts: new Date().toISOString(),
                type: "error_logged",
                session: sessionId ?? "unknown",
                model: errSm.model ?? "unknown",
                provider: errSm.provider ?? "unknown",
                error_name: apiErr.name,
                error_message: apiErr.data?.message ?? "",
                error_raw: JSON.stringify(apiErr),
                status_code: apiErr.data?.statusCode,
                is_retryable: apiErr.data?.isRetryable ?? false,
              })
            }
          } else {
            appendObservation({
              ts: new Date().toISOString(),
              type: "error_logged",
              session: sessionId ?? "unknown",
              model: errSm.model ?? "unknown",
              provider: errSm.provider ?? "unknown",
              error_name: (error as any).name ?? "Unknown",
              error_message: (error as any).data?.message ?? "",
              error_raw: JSON.stringify(error),
              status_code: undefined,
              is_retryable: false,
            })
          }
        }
      } catch (err) {
        try {
          await client.app.log({
            body: {
              service: "copilot-budget",
              level: "error",
              message: `Event handler error: ${err instanceof Error ? err.message : String(err)}`,
            },
          })
        } catch {
          // Even logging failed, silently ignore
        }
      }
    },

    // ----------------------------------------------------------
    // chat.params: capture model/provider before each LLM call
    // ----------------------------------------------------------
    "chat.params": async ({ sessionID, model, provider }) => {
      try {
        sessionModels.set(sessionID, { model: model.id, provider: provider.info.id })
        debugLogChatParams(model, provider)
      } catch {
        // Non-critical
      }
    },

    // ----------------------------------------------------------
    // System prompt injection
    // ----------------------------------------------------------
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const d = getDaily()
        const rpm = getCurrentRPM()
        const status = getBudgetStatus(
          d.totalTokens, d.totalRequests, d.totalCost, d.byModel,
          d.limitHits.length, config.known_preview_models,
          config.known_stable_models, config.premium_request_multipliers
        )

        const pr = await pollPremiumRequests(config).catch(() => getCachedPremiumRequests())
        const premiumLine = pr ? formatPremiumRequestStatus(pr) : ""

        const limitLine = status.estimatedTokenLimit
          ? `Estimated daily limit: ~${formatTokensShort(status.estimatedTokenLimit)} tokens (confidence: ${Math.round(status.confidence * 100)}%)`
          : "Estimated daily limit: unknown (still learning)"
        const pctLine = status.percentage !== null ? `Usage percentage: ~${status.percentage}%` : ""
        const limitHitLine = d.limitHits.length > 0
          ? `Limit hits today: ${d.limitHits.length} (last at ${d.limitHits[d.limitHits.length - 1]?.ts.split("T")[1]?.split(".")[0] ?? "?"})`
          : ""
        const previewLine = status.previewWarnings ? `\nPreview model warnings:\n${status.previewWarnings}` : ""
        const insightLine = status.insights ? `\nInsights:\n${status.insights}` : ""

        output.system.push(
          `<copilot-budget>
${premiumLine ? premiumLine + "\n" : ""}Daily token usage: ${formatTokensShort(d.totalTokens)} tokens (${d.totalRequests} requests)
${limitLine}
${pctLine}
Cost today: $${d.totalCost.toFixed(4)}
Current rate: ${rpm} req/min (peak: ${d.peakRPM})
${status.modelBreakdown ? `\nModel breakdown:\n${status.modelBreakdown}` : ""}
${limitHitLine}${previewLine}${insightLine}
</copilot-budget>`
        )
      } catch {
        // Non-critical
      }
    },

    // ----------------------------------------------------------
    // Session compaction
    // ----------------------------------------------------------
    "experimental.session.compacting": async (_input, output) => {
      try {
        const d = getDaily()
        output.context.push(
          `The user has used ${formatTokensShort(d.totalTokens)} tokens today across ${d.totalRequests} requests. ${d.limitHits.length > 0 ? `Rate-limited ${d.limitHits.length} time(s) today.` : "No rate limits hit today."}`
        )
      } catch {
        // Non-critical
      }
    },

    // ----------------------------------------------------------
    // Custom tool (for LLM to call)
    // ----------------------------------------------------------
    tool: {
      budget: budgetTool,
    },
  }
}) satisfies Plugin

export default plugin
