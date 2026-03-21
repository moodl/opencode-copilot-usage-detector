import type { DailyState, ModelUsage, SessionState, UsageEvent } from "./types.js"
import { appendObservation, readTodayObservations } from "./persistence.js"

// ============================================================
// Globals
// ============================================================

let daily: DailyState = createEmptyDay()
const sessions = new Map<string, SessionState>()

// Track the last processed message ID to avoid double-counting.
// message.updated fires multiple times for the same message as parts stream in.
const processedMessages = new Set<string>()

// ============================================================
// Helpers
// ============================================================

function todayString(): string {
  return new Date().toISOString().split("T")[0]
}

function createEmptyDay(): DailyState {
  return {
    date: todayString(),
    totalTokens: 0,
    totalRequests: 0,
    totalCost: 0,
    byModel: {},
    requestTimestamps: [],
    peakRPM: 0,
    limitHits: [],
    notifiedThresholds: new Set(),
    lastLimitHitTs: null,
    inLimitState: false,
  }
}

function ensureModel(model: string): ModelUsage {
  if (!daily.byModel[model]) {
    daily.byModel[model] = { tokens: 0, requests: 0 }
  }
  return daily.byModel[model]
}

function pruneRpmWindow(): void {
  const now = Date.now()
  daily.requestTimestamps = daily.requestTimestamps.filter(
    (ts) => now - ts < 60_000
  )
}

export function getCurrentRPM(): number {
  pruneRpmWindow()
  return daily.requestTimestamps.length
}

// ============================================================
// Day rollover
// ============================================================

function checkDayRollover(): void {
  const today = todayString()
  if (daily.date !== today) {
    // Write day_end event for previous day
    const dayEnd = {
      ts: daily.date + "T23:59:59Z",
      type: "day_end" as const,
      day_cumulative_tokens: daily.totalTokens,
      day_cumulative_requests: daily.totalRequests,
      limit_hit: daily.limitHits.length > 0,
      limit_hit_at_tokens: daily.limitHits.length > 0
        ? daily.limitHits[0].tokensAtHit
        : null,
      limit_hit_at_requests: daily.limitHits.length > 0
        ? daily.limitHits[0].requestsAtHit
        : null,
      models_used: { ...daily.byModel },
    }
    appendObservation(dayEnd)

    // Reset for new day
    daily = createEmptyDay()
    processedMessages.clear()
  }
}

// ============================================================
// Startup recovery
// ============================================================

export function recoverFromJSONL(): void {
  const today = todayString()
  const events = readTodayObservations(today)

  daily = createEmptyDay()
  processedMessages.clear()

  for (const event of events) {
    if (event.type === "usage") {
      const tokens =
        event.input_tokens +
        event.output_tokens +
        event.reasoning_tokens +
        event.cache_read +
        event.cache_write
      daily.totalTokens += tokens
      daily.totalRequests += 1
      daily.totalCost += event.cost
      const m = ensureModel(event.model)
      m.tokens += tokens
      m.requests += 1
    }
    if (event.type === "limit_hit") {
      daily.limitHits.push({
        ts: event.ts,
        model: event.model,
        class: event.class,
        tokensAtHit: event.day_cumulative_tokens,
        requestsAtHit: event.day_cumulative_requests,
        rpmAtHit: event.requests_last_minute,
      })
      daily.inLimitState = true
      daily.lastLimitHitTs = new Date(event.ts).getTime()
    }
    if (event.type === "recovery") {
      daily.inLimitState = false
    }
  }
}

// ============================================================
// Process incoming assistant message
// ============================================================

export interface AssistantTokens {
  total: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface IncomingMessage {
  messageId: string
  sessionId: string
  modelId: string
  providerId: string
  tokens: AssistantTokens
  cost: number
  finished: boolean
}

export function processAssistantMessage(msg: IncomingMessage): void {
  checkDayRollover()

  // Only process finished messages, and only once
  if (!msg.finished) return
  if (processedMessages.has(msg.messageId)) return
  processedMessages.add(msg.messageId)

  // Skip zero-token messages (e.g. empty responses)
  const totalTokens = msg.tokens.input + msg.tokens.output + msg.tokens.reasoning +
    msg.tokens.cache.read + msg.tokens.cache.write
  if (totalTokens === 0) return

  // Update daily state
  daily.totalTokens += totalTokens
  daily.totalRequests += 1
  daily.totalCost += msg.cost

  const m = ensureModel(msg.modelId)
  m.tokens += totalTokens
  m.requests += 1

  // RPM tracking
  daily.requestTimestamps.push(Date.now())
  pruneRpmWindow()
  daily.peakRPM = Math.max(daily.peakRPM, daily.requestTimestamps.length)

  // If we were in a limit state and now got a successful response, that's a recovery
  if (daily.inLimitState) {
    const minutesSinceLimit = daily.lastLimitHitTs
      ? (Date.now() - daily.lastLimitHitTs) / 60_000
      : 0
    appendObservation({
      ts: new Date().toISOString(),
      type: "recovery",
      model: msg.modelId,
      day_cumulative_tokens: daily.totalTokens,
      minutes_since_limit: Math.round(minutesSinceLimit),
    })
    daily.inLimitState = false
  }

  // Write observation
  const event: UsageEvent = {
    ts: new Date().toISOString(),
    type: "usage",
    session: msg.sessionId,
    model: msg.modelId,
    provider: msg.providerId,
    input_tokens: msg.tokens.input,
    output_tokens: msg.tokens.output,
    reasoning_tokens: msg.tokens.reasoning,
    cache_read: msg.tokens.cache.read,
    cache_write: msg.tokens.cache.write,
    cost: msg.cost,
    day_cumulative_tokens: daily.totalTokens,
    day_cumulative_requests: daily.totalRequests,
    requests_last_minute: getCurrentRPM(),
    request_ok: true,
  }
  appendObservation(event)
}

// ============================================================
// Process error event
// ============================================================

export interface IncomingError {
  sessionId: string | undefined
  errorName: string
  errorMessage: string
  errorRaw: string
  statusCode: number | undefined
  isRetryable: boolean
  responseHeaders: Record<string, string> | undefined
  responseBody: string | undefined
}

export function processErrorEvent(
  err: IncomingError,
  lastRequestedModel: string | null,
  lastRequestedProvider: string | null
): string {
  checkDayRollover()

  const rpm = getCurrentRPM()
  const ts = new Date().toISOString()

  appendObservation({
    ts,
    type: "limit_hit",
    session: err.sessionId ?? "unknown",
    model: lastRequestedModel ?? "unknown",
    provider: lastRequestedProvider ?? "unknown",
    day_cumulative_tokens: daily.totalTokens,
    day_cumulative_requests: daily.totalRequests,
    requests_last_minute: rpm,
    error_name: err.errorName,
    error_message: err.errorMessage,
    error_raw: err.errorRaw,
    status_code: err.statusCode,
    is_retryable: err.isRetryable,
    response_headers: err.responseHeaders,
    response_body: err.responseBody,
    class: "unknown",
  })

  daily.limitHits.push({
    ts,
    model: lastRequestedModel ?? "unknown",
    class: "unknown",
    tokensAtHit: daily.totalTokens,
    requestsAtHit: daily.totalRequests,
    rpmAtHit: rpm,
  })

  daily.inLimitState = true
  daily.lastLimitHitTs = Date.now()

  return ts
}

// ============================================================
// Getters for other modules
// ============================================================

export function getDaily(): DailyState {
  checkDayRollover()
  return daily
}

export function getSession(id: string): SessionState {
  let s = sessions.get(id)
  if (!s) {
    s = {
      id,
      tokensThisSession: 0,
      requestsThisSession: 0,
      currentModel: null,
      currentProvider: null,
      notifiedThresholds: new Set(),
    }
    sessions.set(id, s)
  }
  return s
}
