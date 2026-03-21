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
  resetState,
} from "./aggregator.js"
import {
  ensureDataDir,
  readConfig,
  appendObservation,
  readObservations,
  readEstimates,
  clearTodayObservations,
  removeObservations,
  clearEstimates,
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
import { handled } from "./command-handled.js"

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

const MODEL_BLOCKED_MESSAGE_PATTERNS = [
  "not available",
  "not supported",
  "forbidden",
  "access denied",
  "not authorized",
  "not included",
  "not enabled",
  "model not found",
  "not allowed",
  "not permitted",
  "does not have access",
  "not part of your",
  "unavailable for your",
]

export function isModelBlockedError(
  error: ApiError,
  modelCumulativeTokens: number,
  modelCumulativeRequests: number
): boolean {
  const code = error.data?.statusCode
  const msg = error.data?.message?.toLowerCase() ?? ""

  // 403 Forbidden — always blocked
  if (code === 403) return true

  // Message patterns + model was never successfully used
  if (modelCumulativeTokens === 0 && modelCumulativeRequests === 0) {
    if (MODEL_BLOCKED_MESSAGE_PATTERNS.some((p) => msg.includes(p))) return true
  }

  // 401 with model-specific denial (not generic auth failure)
  if (code === 401 && MODEL_BLOCKED_MESSAGE_PATTERNS.some((p) => msg.includes(p))) {
    return true
  }

  return false
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
  const { config, warnings: configWarnings } = readConfig()
  if (config.debug) {
    enableDebug()
  }
  if (config.timezone) {
    setTimezone(config.timezone)
  }
  recoverFromJSONL()

  // Log config warnings
  for (const w of configWarnings) {
    try {
      client.app.log({ body: { service: "copilot-budget", level: "warn", message: `Config: ${w}` } })
    } catch { /* */ }
  }

  // Cache whether a session is a subagent (avoids repeated API calls)
  const subagentCache = new Map<string, boolean>()

  // Track the last requested model per session (avoids cross-session contamination)
  const sessionModels = new Map<string, { model: string; provider: string; ts: number }>()
  const SESSION_MODEL_MAX = 500
  const SESSION_MODEL_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  function getSessionModel(sessionId: string): { model: string | null; provider: string | null } {
    const entry = sessionModels.get(sessionId)
    return entry ? { model: entry.model, provider: entry.provider } : { model: null, provider: null }
  }

  function pruneSessionModels(): void {
    if (sessionModels.size <= SESSION_MODEL_MAX) return
    const now = Date.now()
    for (const [key, val] of sessionModels) {
      if (now - val.ts > SESSION_MODEL_TTL_MS) sessionModels.delete(key)
    }
    // If still over limit, drop oldest half
    if (sessionModels.size > SESSION_MODEL_MAX) {
      const entries = [...sessionModels.entries()].sort((a, b) => a[1].ts - b[1].ts)
      const toDelete = entries.slice(0, Math.floor(entries.length / 2))
      for (const [key] of toDelete) sessionModels.delete(key)
    }
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

  // Non-intrusive toast notification (doesn't pollute conversation)
  async function showToast(
    title: string,
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info"
  ): Promise<void> {
    try {
      await client.tui.showToast({ body: { title, message, variant, duration: 5000 } })
    } catch {
      // Toast failure is not critical
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
        case "reset": {
          const today = getDaily().date
          const removed = clearTodayObservations(today)
          clearEstimates()
          resetState()
          recoverFromJSONL()
          result = `Day reset: removed ${removed} observation(s) for ${today}. In-memory state cleared. Estimates deleted.`
          break
        }
        case "clean": {
          const cleanTarget = args[1]?.toLowerCase()
          if (!cleanTarget) {
            result = [
              "## /budget clean",
              "",
              "Remove specific entries from the observation log:",
              "",
              "- `/budget clean errors` — Remove all error_logged entries",
              "- `/budget clean blocked` — Remove all model_blocked entries",
              "- `/budget clean limit_hits` — Remove all limit_hit entries",
              "- `/budget clean fake_hits` — Remove limit_hits from models with no usage (blocked models misrecorded as rate limits)",
              "- `/budget clean model <name>` — Remove all entries for a specific model",
              "- `/budget clean before <date>` — Remove entries before a date (YYYY-MM-DD)",
              "",
              "After cleaning, estimates are recomputed automatically.",
            ].join("\n")
          } else {
            let removed = 0
            let cleanResult: string | null = null
            switch (cleanTarget) {
              case "errors":
                removed = removeObservations({ type: "error_logged" })
                break
              case "blocked":
                removed = removeObservations({ type: "model_blocked" })
                break
              case "limit_hits":
                removed = removeObservations({ type: "limit_hit" })
                break
              case "fake_hits": {
                // Remove limit_hits from models that have no successful usage — these are
                // blocked models that were misrecorded as rate limits by the old code
                const d = getDaily()
                removed = removeObservations({
                  predicate: (e) =>
                    e.type === "limit_hit" &&
                    "model" in e &&
                    !d.byModel[(e as any).model],
                })
                break
              }
              case "model": {
                const modelName = args[2]
                if (!modelName) {
                  cleanResult = "Usage: `/budget clean model <model-name>`"
                  break
                }
                removed = removeObservations({ model: modelName })
                break
              }
              case "before": {
                const beforeDate = args[2]
                if (!beforeDate || !/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
                  cleanResult = "Usage: `/budget clean before YYYY-MM-DD`"
                  break
                }
                removed = removeObservations({ before: beforeDate + "T00:00:00" })
                break
              }
              default:
                cleanResult = `Unknown clean target: ${cleanTarget}. Run \`/budget clean\` for options.`
            }
            if (cleanResult) {
              result = cleanResult
            } else {
              // Recompute after cleaning
              clearEstimates()
              resetState()
              recoverFromJSONL()
              try {
                computeEstimates(
                  config.known_preview_models,
                  config.known_stable_models,
                  config.premium_request_multipliers
                )
              } catch { /* */ }
              result = `Cleaned ${removed} observation(s). Estimates recomputed.`
            }
          }
          break
        }
        default:
          result = [
            "## /budget commands",
            "",
            "- `/budget` or `/budget status` — Current usage and estimates",
            "- `/budget history` — Daily usage for the last 14 days",
            "- `/budget insights` — Learned patterns and limit analysis",
            "- `/budget errors` — Rate limit events and error catalog",
            "- `/budget recompute` — Force recompute all estimates",
            "- `/budget reset` — Wipe today's data and start fresh",
            "- `/budget clean [target]` — Remove specific entries from log",
          ].join("\n")
      }

      // Send result as a no-reply message, then throw sentinel to abort
      // the command flow before OpenCode invokes the LLM.
      // This is the standard pattern used by opencode-quota, DCP, etc.
      await sendMessage(input.sessionID, result)
      handled()
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
              await showToast(
                "Budget Warning",
                `${pctStr} of daily budget used (${formatTokensShort(d.totalTokens)} / ~${limitStr} est.)${confStr}`,
                "warning"
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
            const errModel = errSm.model ?? "unknown"
            const modelUsage = getDaily().byModel[errModel]
            const modelTokens = modelUsage?.tokens ?? 0
            const modelRequests = modelUsage?.requests ?? 0

            // Helper: record blocked model event and optionally notify user
            async function handleBlockedModel(): Promise<void> {
              const d = getDaily()
              const blockedTs = new Date().toISOString()
              const alreadyNotified = d.blockedModels.some((b) => b.model === errModel)

              d.blockedModels.push({
                ts: blockedTs,
                model: errModel,
                errorMessage: apiErr.data?.message ?? "",
                statusCode: apiErr.data?.statusCode,
              })

              appendObservation({
                ts: blockedTs,
                type: "model_blocked",
                session: sessionId ?? "unknown",
                model: errModel,
                provider: errSm.provider ?? "unknown",
                error_name: apiErr.name,
                error_message: apiErr.data?.message ?? "",
                error_raw: JSON.stringify(apiErr),
                status_code: apiErr.data?.statusCode,
                is_retryable: apiErr.data?.isRetryable ?? false,
                day_cumulative_tokens: d.totalTokens,
                day_cumulative_requests: d.totalRequests,
              })

              // Only notify once per model per day
              if (!alreadyNotified) {
                await showToast(
                  "Model Blocked",
                  `${errModel} is not available on your plan (status: ${apiErr.data?.statusCode ?? "unknown"})`,
                  "warning"
                )
              }
            }

            // Check for blocked model BEFORE rate limit check
            if (isModelBlockedError(apiErr, modelTokens, modelRequests)) {
              await handleBlockedModel()
              return // Skip rate-limit path entirely
            }

            const rateLimitHeaders = extractRateLimitHeaders(apiErr.data?.responseHeaders)
            const classification = classifyErrorImmediate(
              apiErr.data?.message ?? "", apiErr.data?.statusCode, apiErr.data?.responseHeaders
            )

            // Safety net: classifier detected blocked model that bypassed isModelBlockedError
            if (classification.class === "model_blocked") {
              await handleBlockedModel()
              return
            }

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

              // Notify user via toast (non-intrusive)
              await showToast(
                "Rate Limited",
                `${formatTokensShort(d.totalTokens)} tokens, ${d.totalRequests} req | ${errSm.model ?? "unknown"} | ${classification.class}`,
                "error"
              )
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
        sessionModels.set(sessionID, { model: model.id, provider: provider.info.id, ts: Date.now() })
        pruneSessionModels()
        debugLogChatParams(model, provider)
      } catch {
        // Non-critical
      }
    },

    // ----------------------------------------------------------
    // System prompt injection
    // ----------------------------------------------------------
    "experimental.chat.system.transform": async (input, output) => {
      try {
        // Skip injection for subagent sessions to save tokens
        if (input.sessionID) {
          if (!subagentCache.has(input.sessionID)) {
            try {
              const session = await client.session.get({ path: { id: input.sessionID } })
              subagentCache.set(input.sessionID, !!session.data?.parentID)
            } catch {
              subagentCache.set(input.sessionID, false)
            }
          }
          if (subagentCache.get(input.sessionID)) return
        }

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
        const blockedLine = d.blockedModels.length > 0
          ? `Blocked models: ${[...new Set(d.blockedModels.map((b) => b.model))].join(", ")}`
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
${limitHitLine}
${blockedLine}${previewLine}${insightLine}
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
        const blockedStr = d.blockedModels.length > 0
          ? ` ${[...new Set(d.blockedModels.map((b) => b.model))].length} model(s) are blocked.`
          : ""
        output.context.push(
          `The user has used ${formatTokensShort(d.totalTokens)} tokens today across ${d.totalRequests} requests. ${d.limitHits.length > 0 ? `Rate-limited ${d.limitHits.length} time(s) today.` : "No rate limits hit today."}${blockedStr}`
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
