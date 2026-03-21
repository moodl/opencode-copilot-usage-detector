import type { Plugin } from "@opencode-ai/plugin"
import type { AssistantTokens, IncomingMessage, IncomingError } from "./aggregator.js"
import {
  recoverFromJSONL,
  processAssistantMessage,
  processErrorEvent,
  getDaily,
  getCurrentRPM,
} from "./aggregator.js"
import { ensureDataDir, readConfig } from "./persistence.js"
import { budgetTool } from "./tools.js"
import { enableDebug, debugLogEvent, debugLogChatParams } from "./debug.js"

// ============================================================
// Helpers
// ============================================================

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

// ============================================================
// Plugin
// ============================================================

const plugin: Plugin = async ({ client }) => {
  // Initialize
  ensureDataDir()
  const config = readConfig()
  if ((config as any).debug) {
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
    event: async ({ event }) => {
      try {
        // Debug: log ALL events when debug mode is enabled
        debugLogEvent(event.type, event)

        // ----- message.updated: extract tokens from assistant messages -----
        if (event.type === "message.updated") {
          const msg = (event as any).properties?.info
          if (!msg || msg.role !== "assistant") return

          // Only process if the message has a finish reason (completed)
          const finished = !!msg.finish
          const tokens: AssistantTokens = msg.tokens ?? {
            total: 0,
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
            tokens,
            cost: msg.cost ?? 0,
            finished,
          }

          processAssistantMessage(incoming)

          // Check if we were in limit state and this is a recovery
          // (handled inside processAssistantMessage)
        }

        // ----- session.error: detect rate limits -----
        if (event.type === "session.error") {
          const props = (event as any).properties
          const error = props?.error
          if (!error) return

          // Only process API errors (rate limits etc.)
          // Other error types: ProviderAuthError, UnknownError, MessageOutputLengthError, MessageAbortedError
          const isApiError = error.name === "APIError"
          const isRateLimitLikely =
            isApiError &&
            (error.data?.statusCode === 429 ||
              error.data?.message?.toLowerCase().includes("rate") ||
              error.data?.message?.toLowerCase().includes("limit") ||
              error.data?.message?.toLowerCase().includes("exceeded") ||
              error.data?.message?.toLowerCase().includes("capacity"))

          if (!isRateLimitLikely) return

          const incomingError: IncomingError = {
            sessionId: props.sessionID,
            errorName: error.name,
            errorMessage: error.data?.message ?? "",
            errorRaw: JSON.stringify(error),
            statusCode: error.data?.statusCode,
            isRetryable: error.data?.isRetryable ?? false,
            responseHeaders: error.data?.responseHeaders,
            responseBody: error.data?.responseBody,
          }

          processErrorEvent(incomingError, lastRequestedModel, lastRequestedProvider)

          // Notify user about rate limit
          const sessionId = props.sessionID
          if (sessionId) {
            const d = getDaily()
            try {
              await client.session.promptAsync({
                path: { id: sessionId },
                body: {
                  noReply: true,
                  parts: [
                    {
                      type: "text",
                      text: `\u{1F534} **Rate limited!** Day total: ${formatTokensShort(d.totalTokens)} tokens, ${d.totalRequests} requests | Model: ${lastRequestedModel ?? "unknown"} | Status: ${error.data?.statusCode ?? "unknown"}\n\nRun \`/budget errors\` for details.`,
                    },
                  ],
                },
              })
            } catch {
              // Notification failure is not critical
            }
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

        const modelLines = Object.entries(d.byModel)
          .sort((a, b) => b[1].tokens - a[1].tokens)
          .map(([m, u]) => `  ${m}: ${formatTokensShort(u.tokens)} tokens / ${u.requests} requests`)
          .join("\n")

        const limitInfo =
          d.limitHits.length > 0
            ? `\nLimit hits today: ${d.limitHits.length} (last at ${d.limitHits[d.limitHits.length - 1]?.ts.split("T")[1]?.split(".")[0] ?? "?"})`
            : ""

        output.system.push(
          `<copilot-budget>
Daily token usage: ${formatTokensShort(d.totalTokens)} tokens (${d.totalRequests} requests)
Cost today: $${d.totalCost.toFixed(4)}
Current rate: ${rpm} req/min (peak: ${d.peakRPM})
${modelLines ? `\nModel breakdown:\n${modelLines}` : ""}${limitInfo}
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
