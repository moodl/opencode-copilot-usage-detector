import type { Plugin } from "@opencode-ai/plugin"
import type {
  Event,
  EventMessageUpdated,
  EventSessionError,
} from "@opencode-ai/sdk"
import {
  recoverFromJSONL,
  getDaily,
  getCurrentRPM,
  setTimezone,
  resetState,
} from "./aggregator.js"
import {
  ensureDataDir,
  readConfig,
  clearTodayObservations,
  removeObservations,
  clearEstimates,
} from "./persistence.js"
import { budgetTool, formatStatus, formatHistory, formatErrors, formatInsights } from "./tools.js"
import { enableDebug, debugLogEvent, debugLogChatParams, debugLogError } from "./debug.js"
import { getBudgetStatus, computeEstimates } from "./estimator.js"
import {
  pollPremiumRequests,
  getCachedPremiumRequests,
  formatPremiumRequestStatus,
} from "./github-api.js"
import { handled } from "./command-handled.js"
import { handleMessageUpdated, handleSessionError } from "./event-handlers.js"

export { formatTokens as formatTokensShort } from "./format.js"
import { formatTokens as formatTokensShort } from "./format.js"

export { isAssistantMessage, isApiError, isModelBlockedError, isRateLimitError } from "./guards.js"

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
    } catch (e) { debugLogError("copilot-budget.configWarning", e) }
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
      } catch (e) {
        debugLogError("copilot-budget.recomputeEstimates", e)
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
    } catch (e) {
      debugLogError("copilot-budget.sendMessage", e)
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
    } catch (e) {
      debugLogError("copilot-budget.showToast", e)
    }
  }

  // Shared deps for event handlers
  const handlerDeps = {
    config,
    getSessionModel,
    showToast,
    maybeRecomputeEstimates,
    incrementUsageEvents: () => { usageEventsSinceRecompute++ },
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
      _output: { parts: unknown[] }
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
                const d = getDaily()
                removed = removeObservations({
                  predicate: (e) =>
                    e.type === "limit_hit" &&
                    !d.byModel[e.model],
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
              clearEstimates()
              resetState()
              recoverFromJSONL()
              try {
                computeEstimates(
                  config.known_preview_models,
                  config.known_stable_models,
                  config.premium_request_multipliers
                )
              } catch (e) { debugLogError("copilot-budget.cleanRecompute", e) }
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

      await sendMessage(input.sessionID, result)
      handled()
    },

    // ----------------------------------------------------------
    // Event handler (delegates to extracted handlers)
    // ----------------------------------------------------------
    event: async ({ event }: { event: Event }) => {
      try {
        debugLogEvent(event.type, event)

        if (event.type === "message.updated") {
          await handleMessageUpdated(handlerDeps, event as EventMessageUpdated)
        }

        if (event.type === "session.error") {
          await handleSessionError(handlerDeps, event as EventSessionError)
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
        } catch (e) {
          debugLogError("copilot-budget.eventHandlerLog", e)
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
      } catch (e) {
        debugLogError("copilot-budget.chatParams", e)
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
            } catch (e) {
              debugLogError("copilot-budget.subagentCheck", e)
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
Current rate: ${rpm} req/min (peak: ${d.peakRPM})
${status.modelBreakdown ? `\nModel breakdown:\n${status.modelBreakdown}` : ""}
${limitHitLine}
${blockedLine}${previewLine}${insightLine}
</copilot-budget>`
        )
      } catch (e) {
        debugLogError("copilot-budget.systemTransform", e)
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
      } catch (e) {
        debugLogError("copilot-budget.sessionCompacting", e)
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
