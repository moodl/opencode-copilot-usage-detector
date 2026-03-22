import type {
  EventMessageUpdated,
  EventSessionError,
  ApiError,
} from "@opencode-ai/sdk"
import type { IncomingMessage, IncomingError } from "./aggregator.js"
import type { PluginConfig, ObservationEvent, UsageEvent } from "./types.js"
import type { ReclassificationContext } from "./classifier.js"
import {
  processAssistantMessage,
  processErrorEvent,
  getDaily,
} from "./aggregator.js"
import {
  appendObservation,
  readObservations,
  readEstimates,
} from "./persistence.js"
import { debugLogError } from "./debug.js"
import { formatTokens } from "./format.js"
import { isAssistantMessage, isApiError, isModelBlockedError, isRateLimitError } from "./guards.js"
import {
  classifyErrorImmediate,
  scheduleReclassification,
} from "./classifier.js"
import { getBudgetStatus, checkThresholds } from "./estimator.js"

// ============================================================
// Dependencies injected by the plugin
// ============================================================

export interface HandlerDeps {
  config: PluginConfig
  getSessionModel(sessionId: string): { model: string | null; provider: string | null }
  showToast(title: string, message: string, variant?: "info" | "success" | "warning" | "error"): Promise<void>
  maybeRecomputeEstimates(force?: boolean): void
  incrementUsageEvents(): void
}

// ============================================================
// message.updated handler
// ============================================================

export async function handleMessageUpdated(
  deps: HandlerDeps,
  event: EventMessageUpdated
): Promise<void> {
  const msg = event.properties.info
  if (!isAssistantMessage(msg)) return

  const finished = !!msg.finish
  const tokens = msg.tokens ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }

  const sm = deps.getSessionModel(msg.sessionID)
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
  deps.incrementUsageEvents()
  deps.maybeRecomputeEstimates()

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
  if (finished && !deps.config.quiet_mode) {
    const d = getDaily()
    const status = getBudgetStatus(
      d.totalTokens, d.totalRequests, d.totalCost, d.byModel,
      d.limitHits.length, deps.config.known_preview_models,
      deps.config.known_stable_models, deps.config.premium_request_multipliers
    )

    const threshold = checkThresholds(
      status.percentage, deps.config.notification_thresholds, d.notifiedThresholds
    )

    if (threshold !== null) {
      d.notifiedThresholds.add(threshold)
      const pctStr = status.percentage !== null ? `${status.percentage}%` : "?"
      const limitStr = status.estimatedTokenLimit
        ? formatTokens(status.estimatedTokenLimit) : "unknown"
      const confStr = status.confidence > 0.8 ? ""
        : status.confidence > 0.5 ? " (moderate confidence)" : " (low confidence)"
      await deps.showToast(
        "Budget Warning",
        `${pctStr} of daily budget used (${formatTokens(d.totalTokens)} / ~${limitStr} est.)${confStr}`,
        "warning"
      )
    }
  }
}

// ============================================================
// session.error handler
// ============================================================

export async function handleSessionError(
  deps: HandlerDeps,
  event: EventSessionError
): Promise<void> {
  const error = event.properties.error
  if (!error) return
  const sessionId = event.properties.sessionID
  const errSm = deps.getSessionModel(sessionId ?? "")

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
        await deps.showToast(
          "Model Blocked",
          `${errModel} is not available on your plan (status: ${apiErr.data?.statusCode ?? "unknown"})`,
          "warning"
        )
      }
    }

    // Check for blocked model BEFORE rate limit check
    if (isModelBlockedError(apiErr, modelTokens, modelRequests)) {
      await handleBlockedModel()
      return
    }

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

      const errorTs = processErrorEvent(incomingError, errSm.model, errSm.provider, classification.class)
      deps.maybeRecomputeEstimates(true)

      const d = getDaily()

      // Schedule delayed reclassification (10 min after event)
      scheduleReclassification(errorTs, () =>
        buildReclassificationContext(errorTs, errSm.model ?? "unknown")
      )

      // Notify user via toast (non-intrusive)
      await deps.showToast(
        "Rate Limited",
        `${formatTokens(d.totalTokens)} tokens, ${d.totalRequests} req | ${errSm.model ?? "unknown"} | ${classification.class}`,
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
      error_name: String((error as Record<string, unknown>).name ?? "Unknown"),
      error_message: (() => {
        const data = (error as Record<string, unknown>).data
        return typeof data === "object" && data !== null
          ? String((data as Record<string, unknown>).message ?? "")
          : ""
      })(),
      error_raw: JSON.stringify(error),
      status_code: undefined,
      is_retryable: false,
    })
  }
}

// ============================================================
// Reclassification context builder
// ============================================================

export function buildReclassificationContext(
  errorTs: string,
  errorModel: string
): ReclassificationContext {
  const current = getDaily()
  const recentObs = readObservations({ since: errorTs })
  const otherModels = recentObs
    .filter((o): o is UsageEvent => o.type === "usage" && o.model !== errorModel)
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
      model: o.type === "usage" || o.type === "limit_hit" || o.type === "recovery" || o.type === "model_blocked" || o.type === "error_logged" ? o.model : undefined,
      ts: o.ts,
    })),
    dailyTokens: current.totalTokens,
    dailyRequests: current.totalRequests,
    globalEstimate: readGlobalEstimate(),
    otherModelsWorking: uniqueOtherModels.length > 0,
    workingModels: uniqueOtherModels,
    errorRate: totalRecent > 0 ? errorRecent / totalRecent : 0,
    minutesSinceError: (Date.now() - new Date(errorTs).getTime()) / 60_000,
    hasRecovered: !!recoveryEvent,
    recoveryMinutes,
  }
}

function readGlobalEstimate(): number | null {
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
  } catch (e) {
    debugLogError("event-handlers.readGlobalEstimate", e)
    return null
  }
}
