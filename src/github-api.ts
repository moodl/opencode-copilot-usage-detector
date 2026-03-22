import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import type {
  ApiAuthMethod,
  ApiStatus,
  PremiumRequestSummary,
  BillingUsageResponse,
  PluginConfig,
} from "./types.js"
import { debugLogError } from "./debug.js"

// ============================================================
// Constants
// ============================================================

const POLL_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")
const GITHUB_API_BASE = "https://api.github.com"

// Monthly allowances by plan
const PLAN_ALLOWANCES: Record<string, number> = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
}

// ============================================================
// State
// ============================================================

let apiStatus: ApiStatus = {
  authMethod: "none",
  username: null,
  lastFetch: 0,
  lastError: null,
  premiumRequests: null,
}

let authProbed = false
let authNotifiedUser = false

// ============================================================
// Auth probing
// ============================================================

function readCopilotToken(): string | null {
  try {
    if (!existsSync(AUTH_FILE)) return null
    const raw = JSON.parse(readFileSync(AUTH_FILE, "utf-8"))
    const copilot = raw["github-copilot"]
    if (copilot && typeof copilot.access === "string") {
      return copilot.access
    }
    return null
  } catch (e) {
    debugLogError("github-api.readCopilotToken", e)
    return null
  }
}

async function tryFetchWithToken(
  url: string,
  token: string
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    const data = await resp.json()
    return { ok: resp.ok, status: resp.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err) } }
  }
}

function tryGhCli(path: string): { ok: boolean; data: unknown } {
  try {
    const result = execFileSync("gh", ["api", path], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { ok: true, data: JSON.parse(result) }
  } catch (e) {
    debugLogError("github-api.tryGhCli", e)
    return { ok: false, data: null }
  }
}

async function probeAuth(): Promise<void> {
  if (authProbed) return
  authProbed = true

  // Try 1: Copilot OAuth token
  const copilotToken = readCopilotToken()
  if (copilotToken) {
    const result = await tryFetchWithToken(`${GITHUB_API_BASE}/user`, copilotToken)
    if (result.ok && typeof result.data === "object" && result.data !== null) {
      const login = (result.data as Record<string, unknown>).login
      if (typeof login === "string") {
        apiStatus.authMethod = "copilot_token"
        apiStatus.username = login
        return
      }
    }
  }

  // Try 2: gh CLI
  const ghResult = tryGhCli("/user")
  if (ghResult.ok && typeof ghResult.data === "object" && ghResult.data !== null) {
    const login = (ghResult.data as Record<string, unknown>).login
    if (typeof login === "string") {
      apiStatus.authMethod = "gh_cli"
      apiStatus.username = login
      return
    }
  }

  apiStatus.authMethod = "none"
  apiStatus.lastError = "No valid auth method found"
}

// ============================================================
// Fetch premium request usage
// ============================================================

async function fetchPremiumRequests(
  config: PluginConfig
): Promise<PremiumRequestSummary | null> {
  await probeAuth()

  if (apiStatus.authMethod === "none" || !apiStatus.username) {
    return null
  }

  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  const path = `/users/${apiStatus.username}/settings/billing/premium_request/usage?year=${year}&month=${month}`

  let data: unknown = null

  if (apiStatus.authMethod === "copilot_token") {
    const token = readCopilotToken()
    if (!token) return null
    const result = await tryFetchWithToken(`${GITHUB_API_BASE}${path}`, token)
    if (!result.ok) {
      // Token might not have the right scope — try gh CLI as fallback
      apiStatus.authMethod = "gh_cli"
    } else {
      data = result.data
    }
  }

  if (apiStatus.authMethod === "gh_cli" && !data) {
    const result = tryGhCli(path)
    if (!result.ok) {
      apiStatus.lastError = "gh CLI failed to fetch billing data. Run: gh auth refresh -h github.com -s user"
      return null
    }
    data = result.data
  }

  if (!data) return null

  // Parse the response
  return parsePremiumRequestResponse(data, config)
}

export function parsePremiumRequestResponse(
  data: unknown,
  config: PluginConfig
): PremiumRequestSummary | null {
  try {
    // The API may return different structures depending on the endpoint version
    // Handle both array and object responses
    let items: unknown[] = []

    if (Array.isArray(data)) {
      items = data
    } else if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>
      if (Array.isArray(obj.usageItems)) {
        items = obj.usageItems
      } else if (Array.isArray(obj.usage_items)) {
        items = obj.usage_items
      }
    }

    if (items.length === 0 && typeof data === "object" && data !== null) {
      // Maybe the response itself is the summary
      const obj = data as Record<string, unknown>
      if (typeof obj.total_premium_requests === "number" || typeof obj.totalPremiumRequests === "number") {
        const total = (obj.total_premium_requests ?? obj.totalPremiumRequests) as number
        const allowance = PLAN_ALLOWANCES[config.copilot_plan.toLowerCase()] ?? config.monthly_premium_allowance
        return {
          totalPremiumRequests: total,
          byModel: {},
          byProduct: {},
          monthlyAllowance: allowance,
          remaining: Math.max(0, allowance - total),
          percentUsed: allowance > 0 ? Math.round((total / allowance) * 100) : 0,
          fetchedAt: new Date().toISOString(),
        }
      }
    }

    // Parse individual items
    const byModel: Record<string, number> = {}
    const byProduct: Record<string, number> = {}
    let totalQuantity = 0

    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const entry = item as Record<string, unknown>
      const quantity = typeof entry.quantity === "number" ? entry.quantity : 0
      const sku = typeof entry.sku === "string" ? entry.sku : "unknown"
      const product = typeof entry.product === "string" ? entry.product : "unknown"

      totalQuantity += quantity
      byModel[sku] = (byModel[sku] ?? 0) + quantity
      byProduct[product] = (byProduct[product] ?? 0) + quantity
    }

    const allowance = PLAN_ALLOWANCES[config.copilot_plan.toLowerCase()] ?? config.monthly_premium_allowance

    return {
      totalPremiumRequests: totalQuantity,
      byModel,
      byProduct,
      monthlyAllowance: allowance,
      remaining: Math.max(0, allowance - totalQuantity),
      percentUsed: allowance > 0 ? Math.round((totalQuantity / allowance) * 100) : 0,
      fetchedAt: new Date().toISOString(),
    }
  } catch (e) {
    debugLogError("github-api.parsePremiumRequestResponse", e)
    return null
  }
}

// ============================================================
// Public API
// ============================================================

export async function pollPremiumRequests(
  config: PluginConfig,
  force = false
): Promise<PremiumRequestSummary | null> {
  const now = Date.now()

  // Don't poll more often than the interval
  if (!force && now - apiStatus.lastFetch < POLL_INTERVAL_MS) {
    return apiStatus.premiumRequests
  }

  apiStatus.lastFetch = now

  try {
    const result = await fetchPremiumRequests(config)
    if (result) {
      apiStatus.premiumRequests = result
      apiStatus.lastError = null
    }
    return result
  } catch (err) {
    apiStatus.lastError = err instanceof Error ? err.message : String(err)
    return apiStatus.premiumRequests // Return cached data on error
  }
}

export function getCachedPremiumRequests(): PremiumRequestSummary | null {
  return apiStatus.premiumRequests
}

export function getApiStatus(): ApiStatus {
  return { ...apiStatus }
}

export function needsAuthSetup(): boolean {
  return authProbed && apiStatus.authMethod === "none"
}

export function getAuthSetupMessage(): string | null {
  if (!needsAuthSetup() || authNotifiedUser) return null
  authNotifiedUser = true
  return "To enable premium request tracking from the GitHub API, run:\n`gh auth refresh -h github.com -s user`\nThen restart OpenCode. Without this, the plugin uses empirical tracking only."
}

/** Reset all module-level state. For testing only. */
export function resetApiState(): void {
  apiStatus = {
    authMethod: "none",
    username: null,
    lastFetch: 0,
    lastError: null,
    premiumRequests: null,
  }
  authProbed = false
  authNotifiedUser = false
}

export function formatPremiumRequestStatus(pr: PremiumRequestSummary): string {
  const lines: string[] = [
    `Premium requests this month: ${pr.totalPremiumRequests} / ${pr.monthlyAllowance} (${pr.percentUsed}% used, ${pr.remaining} remaining)`,
  ]

  const modelEntries = Object.entries(pr.byModel)
  if (modelEntries.length > 0) {
    for (const [model, count] of modelEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${model}: ${count} requests`)
    }
  }

  return lines.join("\n")
}
