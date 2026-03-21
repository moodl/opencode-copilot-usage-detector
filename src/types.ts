// ============================================================
// Observation events (written to observations.jsonl)
// ============================================================

export interface UsageEvent {
  ts: string
  type: "usage"
  session: string
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read: number
  cache_write: number
  cost: number
  day_cumulative_tokens: number
  day_cumulative_requests: number
  requests_last_minute: number
  request_ok: true
}

export interface LimitHitEvent {
  ts: string
  type: "limit_hit"
  session: string
  model: string
  provider: string
  day_cumulative_tokens: number
  day_cumulative_requests: number
  requests_last_minute: number
  error_name: string
  error_message: string
  error_raw: string
  status_code: number | undefined
  is_retryable: boolean
  response_headers: Record<string, string> | undefined
  response_body: string | undefined
  class: LimitClass
}

export interface ReclassifyEvent {
  ts: string
  type: "reclassify"
  ref_ts: string
  old_class: LimitClass
  new_class: LimitClass
  reason: string
  evidence: Record<string, unknown>
}

export interface RecoveryEvent {
  ts: string
  type: "recovery"
  model: string
  day_cumulative_tokens: number
  minutes_since_limit: number
}

export interface ModelFallbackEvent {
  ts: string
  type: "model_fallback"
  requested: string
  received: string
  day_cumulative_tokens: number
}

export interface DayEndEvent {
  ts: string
  type: "day_end"
  day_cumulative_tokens: number
  day_cumulative_requests: number
  limit_hit: boolean
  limit_hit_at_tokens: number | null
  limit_hit_at_requests: number | null
  models_used: Record<string, { tokens: number; requests: number }>
}

export interface ModelBlockedEvent {
  ts: string
  type: "model_blocked"
  session: string
  model: string
  provider: string
  error_name: string
  error_message: string
  error_raw: string
  status_code: number | undefined
  is_retryable: boolean
  day_cumulative_tokens: number
  day_cumulative_requests: number
}

export interface ErrorLoggedEvent {
  ts: string
  type: "error_logged"
  session: string
  model: string
  provider: string
  error_name: string
  error_message: string
  error_raw: string
  status_code: number | undefined
  is_retryable: boolean
}

export type ObservationEvent =
  | UsageEvent
  | LimitHitEvent
  | ReclassifyEvent
  | RecoveryEvent
  | ModelFallbackEvent
  | DayEndEvent
  | ModelBlockedEvent
  | ErrorLoggedEvent

export type LimitClass =
  | "unknown"
  | "hard_daily_limit"
  | "preview_limit"
  | "burst_rpm_limit"
  | "unknown_recovery"
  | "model_blocked"

// ============================================================
// In-memory state
// ============================================================

export interface ModelUsage {
  tokens: number
  requests: number
}

export interface DailyState {
  date: string // "2026-03-21"
  totalTokens: number
  totalRequests: number
  totalCost: number
  byModel: Record<string, ModelUsage>
  requestTimestamps: number[] // for RPM calculation (last 60s)
  peakRPM: number
  limitHits: Array<{
    ts: string
    model: string
    class: LimitClass
    tokensAtHit: number
    requestsAtHit: number
    rpmAtHit: number
  }>
  blockedModels: Array<{
    ts: string
    model: string
    errorMessage: string
    statusCode: number | undefined
  }>
  notifiedThresholds: Set<number>
  lastLimitHitTs: number | null
  inLimitState: boolean // true after limit_hit, false after recovery
}

export interface SessionState {
  id: string
  tokensThisSession: number
  requestsThisSession: number
  currentModel: string | null
  currentProvider: string | null
  notifiedThresholds: Set<number>
}

// ============================================================
// Config
// ============================================================

export interface PluginConfig {
  debug: boolean
  copilot_plan: string
  known_preview_models: string[]
  known_stable_models: string[]
  notification_thresholds: number[]
  premium_request_multipliers: Record<string, number>
  monthly_premium_allowance: number
  timezone: string
  quiet_mode: boolean
}

// ============================================================
// GitHub API types
// ============================================================

export interface PremiumRequestEntry {
  date: string
  product: string
  sku: string
  quantity: number
  unitType: string
  pricePerUnit: number
  grossAmount: number
  discountAmount: number
  netAmount: number
  organizationName: string
  repositorySlug: string | null
}

export interface BillingUsageResponse {
  usageItems: PremiumRequestEntry[]
  [key: string]: unknown
}

export interface PremiumRequestSummary {
  totalPremiumRequests: number
  byModel: Record<string, number>
  byProduct: Record<string, number>
  monthlyAllowance: number
  remaining: number
  percentUsed: number
  fetchedAt: string
}

export type ApiAuthMethod = "copilot_token" | "gh_cli" | "none"

export interface ApiStatus {
  authMethod: ApiAuthMethod
  username: string | null
  lastFetch: number
  lastError: string | null
  premiumRequests: PremiumRequestSummary | null
}

export const DEFAULT_CONFIG: PluginConfig = {
  debug: false,
  copilot_plan: "pro",
  known_preview_models: [],
  known_stable_models: [],
  notification_thresholds: [60, 80, 95],
  premium_request_multipliers: {},
  monthly_premium_allowance: 1000,
  timezone: "Europe/Berlin",
  quiet_mode: false,
}
