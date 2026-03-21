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
} from "./aggregator.js"
import {
  ensureDataDir,
  readConfig,
  appendObservation,
  readObservations,
  readEstimates,
} from "./persistence.js"
import { budgetTool } from "./tools.js"
import { enableDebug, debugLogEvent, debugLogChatParams } from "./debug.js"
import {
  classifyErrorImmediate,
  extractRateLimitHeaders,
  scheduleReclassification,
} from "./classifier.js"
import { getBudgetStatus, checkThresholds, computeEstimates } from "./estimator.js"

// ============================================================
// Helpers
// ============================================================

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as any).role === "assistant" &&
    typeof (msg as any).id === "string"
  )
}

function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as any).name === "APIError"
  )
}

function isRateLimitError(error: ApiError): boolean {
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

const plugin: Plugin = async ({ client }) => {
  // Initialize
  ensureDataDir()
  const config = readConfig()
  if (config.debug) {
    enableDebug()
  }
  recoverFromJSONL()

  // Track the last requested model from chat.params
  let lastRequestedModel: string | null = null
  let lastRequestedProvider: string | null = null

  return {
    // ----------------------------------------------------------
    // Event handler
    // ----------------------------------------------------------
    event: async ({ event }: { event: Event }) => {
      try {
        // Debug: log ALL events when debug mode is enabled
        debugLogEvent(event.type, event)

        // ----- message.updated: extract tokens from assistant messages -----
        if (event.type === "message.updated") {
          const msgEvent = event as EventMessageUpdated
          const msg = msgEvent.properties.info
          if (!isAssistantMessage(msg)) return

          // Only process if the message has a finish reason (completed)
          const finished = !!msg.finish
          const tokens = msg.tokens ?? {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          }

          const incoming: IncomingMessage = {
            messageId: msg.id,
            sessionId: msg.sessionID,
            modelId: msg.modelID ?? lastRequestedModel ?? "unknown",
            providerId: msg.providerID ?? lastRequestedProvider ?? "unknown",
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

          // Detect silent model fallback
          if (finished && msg.modelID && lastRequestedModel && msg.modelID !== lastRequestedModel) {
            appendObservation({
              ts: new Date().toISOString(),
              type: "model_fallback",
              requested: lastRequestedModel,
              received: msg.modelID,
              day_cumulative_tokens: getDaily().totalTokens,
            })
          }

          // Check threshold notifications after processing
          if (finished && !config.quiet_mode) {
            const d = getDaily()
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

            const threshold = checkThresholds(
              status.percentage,
              config.notification_thresholds,
              d.notifiedThresholds
            )

            if (threshold !== null) {
              d.notifiedThresholds.add(threshold)
              try {
                const pctStr = status.percentage !== null ? `${status.percentage}%` : "?"
                const limitStr = status.estimatedTokenLimit
                  ? formatTokensShort(status.estimatedTokenLimit)
                  : "unknown"
                const confStr = status.confidence > 0.8
                  ? ""
                  : status.confidence > 0.5
                    ? " (moderate confidence)"
                    : " (low confidence)"

                await client.session.promptAsync({
                  path: { id: msg.sessionID },
                  body: {
                    noReply: true,
                    parts: [
                      {
                        type: "text",
                        text: `\u{26A1} **${pctStr} of daily Copilot budget used** (${formatTokensShort(d.totalTokens)} / ~${limitStr} est.)${confStr}`,
                      },
                    ],
                  },
                })
              } catch {
                // Notification failure is not critical
              }
            }
          }
        }

        // ----- session.error: log all errors, detect rate limits -----
        if (event.type === "session.error") {
          const errEvent = event as EventSessionError
          const error = errEvent.properties.error
          if (!error) return
          const sessionId = errEvent.properties.sessionID

          if (isApiError(error)) {
            const apiErr = error
            const rateLimitHeaders = extractRateLimitHeaders(apiErr.data?.responseHeaders)
            const classification = classifyErrorImmediate(
              apiErr.data?.message ?? "",
              apiErr.data?.statusCode,
              apiErr.data?.responseHeaders
            )

            if (isRateLimitError(apiErr)) {
              // This looks like a rate limit — log as limit_hit
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

              processErrorEvent(incomingError, lastRequestedModel, lastRequestedProvider)

              // Override the default "unknown" class with classifier result
              const d = getDaily()
              if (d.limitHits.length > 0) {
                d.limitHits[d.limitHits.length - 1].class = classification.class
              }

              // Schedule delayed reclassification
              const errorTs = new Date().toISOString()
              scheduleReclassification(errorTs, () => {
                const current = getDaily()
                const recentObs = readRecentObservations(errorTs)
                const errorModel = lastRequestedModel ?? "unknown"
                const otherModels = recentObs
                  .filter((o) => o.type === "usage" && o.model !== errorModel)
                  .map((o) => (o as any).model as string)
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
                    model: "model" in o ? (o as any).model : undefined,
                    ts: o.ts,
                  })),
                  dailyTokens: current.totalTokens,
                  dailyRequests: current.totalRequests,
                  globalEstimate: (() => {
                    try {
                      const est = readEstimates()
                      return (est as any)?.globalDailyBudget?.tokenEstimate?.value ?? null
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

              // Notify user about rate limit
              if (sessionId) {
                const headerInfo = rateLimitHeaders
                  ? ` | Headers: ${Object.entries(rateLimitHeaders.all).map(([k, v]) => `${k}=${v}`).join(", ")}`
                  : ""
                try {
                  await client.session.promptAsync({
                    path: { id: sessionId },
                    body: {
                      noReply: true,
                      parts: [
                        {
                          type: "text",
                          text: `\u{1F534} **Rate limited!** Day total: ${formatTokensShort(d.totalTokens)} tokens, ${d.totalRequests} requests | Model: ${lastRequestedModel ?? "unknown"} | Status: ${apiErr.data?.statusCode ?? "unknown"} | Class: ${classification.class}${headerInfo}\n\nRun \`/budget errors\` for details.`,
                        },
                      ],
                    },
                  })
                } catch {
                  // Notification failure is not critical
                }
              }
            } else {
              // Non-rate-limit API error — log for catalog building
              appendObservation({
                ts: new Date().toISOString(),
                type: "error_logged",
                session: sessionId ?? "unknown",
                model: lastRequestedModel ?? "unknown",
                provider: lastRequestedProvider ?? "unknown",
                error_name: apiErr.name,
                error_message: apiErr.data?.message ?? "",
                error_raw: JSON.stringify(apiErr),
                status_code: apiErr.data?.statusCode,
                is_retryable: apiErr.data?.isRetryable ?? false,
              })
            }
          } else {
            // Non-API error (ProviderAuthError, UnknownError, etc.) — log for catalog
            appendObservation({
              ts: new Date().toISOString(),
              type: "error_logged",
              session: sessionId ?? "unknown",
              model: lastRequestedModel ?? "unknown",
              provider: lastRequestedProvider ?? "unknown",
              error_name: (error as any).name ?? "Unknown",
              error_message: (error as any).data?.message ?? "",
              error_raw: JSON.stringify(error),
              status_code: undefined,
              is_retryable: false,
            })
          }
        }
      } catch (err) {
        // Plugin errors must NEVER crash OpenCode
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
    "chat.params": async ({ model, provider }) => {
      try {
        lastRequestedModel = model.id
        lastRequestedProvider = provider.info.id
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
          d.totalTokens,
          d.totalRequests,
          d.totalCost,
          d.byModel,
          d.limitHits.length,
          config.known_preview_models,
          config.known_stable_models,
          config.premium_request_multipliers
        )

        const limitLine = status.estimatedTokenLimit
          ? `Estimated daily limit: ~${formatTokensShort(status.estimatedTokenLimit)} tokens (confidence: ${Math.round(status.confidence * 100)}%)`
          : "Estimated daily limit: unknown (still learning)"
        const pctLine = status.percentage !== null
          ? `Usage percentage: ~${status.percentage}%`
          : ""
        const limitHitLine = d.limitHits.length > 0
          ? `Limit hits today: ${d.limitHits.length} (last at ${d.limitHits[d.limitHits.length - 1]?.ts.split("T")[1]?.split(".")[0] ?? "?"})`
          : ""
        const previewLine = status.previewWarnings ? `\nPreview model warnings:\n${status.previewWarnings}` : ""
        const insightLine = status.insights ? `\nInsights:\n${status.insights}` : ""

        output.system.push(
          `<copilot-budget>
Daily token usage: ${formatTokensShort(d.totalTokens)} tokens (${d.totalRequests} requests)
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
    // Session compaction: preserve budget context
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
    // Custom tool
    // ----------------------------------------------------------
    tool: {
      budget: budgetTool,
    },
  }
}

export default plugin
