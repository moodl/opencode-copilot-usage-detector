# opencode-copilot-usage-detector

> **Experimental** — This plugin is in early development. Features may change, data formats may evolve, and there will be rough edges. Use at your own risk and please [report issues](https://github.com/moodl/opencode-copilot-usage-detector/issues).

An [OpenCode](https://opencode.ai) plugin that tracks GitHub Copilot token usage across sessions, empirically learns rate limits, and proactively informs you before you hit them.

## The Problem

GitHub Copilot doesn't publish concrete token/request limits for the coding assistant. There are multiple opaque limit tiers:

- **Monthly premium requests** with model-specific multipliers
- **Short-term burst limits** per time window
- **Preview model limits** that are separate and stricter

This plugin learns these limits from your own usage patterns and warns you as you approach them.

## Features

- **Token & request tracking** — Per-day, per-model usage with RPM monitoring
- **Adaptive limit learning** — Weighted averages with exponential recency decay and confidence scoring
- **Multi-dimensional hypothesis tracking** — Learns whether limits are token-based, request-based, or RPM-based
- **Preview model detection** — Automatically identifies models with separate, stricter limits
- **Rate-limit classification** — 5-stage classifier distinguishing burst, preview, and daily limits
- **System prompt injection** — Budget status in every LLM context (zero tool-call overhead)
- **Threshold notifications** — Configurable alerts at 60%, 80%, 95% of estimated limits
- **Temporal patterns** — Learns what time of day you typically hit limits and how model choice affects runway
- **Model fallback detection** — Detects when Copilot silently downgrades your model
- **GitHub billing API integration** — Fetches real premium request usage when auth is available
- **Full error catalog** — Logs all API errors for pattern analysis

## Requirements

- [OpenCode](https://opencode.ai) v1.2.0 or later
- Node.js 18+
- GitHub Copilot subscription

## Installation

### 1. Install the package

```bash
cd ~/.config/opencode
npm install git+https://github.com/moodl/opencode-copilot-usage-detector.git
```

### 2. Register the plugin

Add it to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-copilot-usage-detector"]
}
```

If you already have other plugins, add it to the existing array:

```json
{
  "plugin": ["@tarquinen/opencode-dcp@latest", "opencode-copilot-usage-detector"]
}
```

### 3. Restart OpenCode

The plugin loads automatically on startup. Use `/budget` to verify it's working.

### Updating

```bash
cd ~/.config/opencode
npm install git+https://github.com/moodl/opencode-copilot-usage-detector.git
```

Then restart OpenCode.

## Usage

The plugin works automatically -- no action needed. It:

1. Tracks every LLM request via event hooks
2. Injects budget status into the system prompt
3. Notifies you in chat when approaching estimated limits
4. Logs everything to `~/.config/copilot-budget/observations.jsonl`

### `/budget` Command

| Command | Description |
|---------|-------------|
| `/budget` or `/budget status` | Current usage, estimates, and model breakdown |
| `/budget history` | Daily token usage for the last 14 days |
| `/budget insights` | Learned patterns, limit estimates, temporal analysis |
| `/budget errors` | Rate limit events and error catalog |
| `/budget recompute` | Force recompute all estimates from observations |

## Configuration

Optionally create `~/.config/copilot-budget/config.json`:

```json
{
  "debug": false,
  "copilot_plan": "pro",
  "known_preview_models": [],
  "known_stable_models": [],
  "notification_thresholds": [60, 80, 95],
  "premium_request_multipliers": {
    "claude-opus-4.5": 3.0,
    "claude-sonnet-4.5": 1.0,
    "gpt-5.4-mini": 0.33
  },
  "monthly_premium_allowance": 1000,
  "timezone": "Europe/Berlin",
  "quiet_mode": false
}
```

All fields are optional -- sensible defaults are used.

| Field | Description | Default |
|-------|-------------|---------|
| `debug` | Log all events to `debug-events.jsonl` | `false` |
| `copilot_plan` | Your Copilot plan (`free`, `pro`, `pro+`, `business`, `enterprise`) | `"pro"` |
| `known_preview_models` | Models to always treat as preview | `[]` |
| `known_stable_models` | Models to always treat as stable | `[]` |
| `notification_thresholds` | Percentage thresholds for chat warnings | `[60, 80, 95]` |
| `premium_request_multipliers` | Model cost multipliers for weighted tracking | `{}` |
| `monthly_premium_allowance` | Override monthly premium request allowance | `1000` |
| `timezone` | Timezone for day boundaries (e.g., `Europe/Berlin`, `America/New_York`) | `"UTC"` |
| `quiet_mode` | Suppress threshold notifications | `false` |

## Data Storage

All data is stored locally in `~/.config/copilot-budget/`:

| File | Description |
|------|-------------|
| `observations.jsonl` | Append-only event log (source of truth) |
| `estimates.json` | Derived limit model (can be deleted and regenerated) |
| `config.json` | User configuration |
| `debug-events.jsonl` | Debug event log (only when `debug: true`) |

The JSONL file auto-rotates at 50MB or when entries are older than 90 days. No data is sent anywhere -- everything stays on your machine.

## How It Learns

1. **Aggregation** -- Every LLM response's token counts are recorded per model per day
2. **Error detection** -- API errors (especially HTTP 429) are captured with full context including response headers
3. **Classification** -- A 5-stage classifier determines if an error is a burst limit, preview limit, or daily limit
4. **Estimation** -- Weighted averages with 14-day half-life produce limit estimates with confidence scores
5. **Insight generation** -- After accumulating data, the system identifies patterns (e.g., "opus-heavy days hit limits 2h earlier")

## Architecture

```
Plugin Entry (copilot-budget.ts)
+-- Config Hook (registers /budget command)
+-- Command Handler (/budget subcommands)
+-- Event Handler (message.updated, session.error)
+-- chat.params Hook (per-session model/provider capture)
+-- System Prompt Injection
+-- Session Compaction Context
+-- Budget Tool (for LLM tool-calling)

Aggregator (aggregator.ts)
+-- Token + Request counting (per-session, per-model)
+-- RPM tracking (sliding window)
+-- Day rollover + recovery detection
+-- Startup recovery from JSONL

Classifier (classifier.ts)
+-- Stage 1: Error message pattern matching
+-- Stage 2: Cross-model correlation
+-- Stage 3: Cancel-rate analysis
+-- Stage 4: Global budget comparison
+-- Stage 5: Recovery-time classification
+-- Delayed reclassification (10-min timer)

Estimator (estimator.ts)
+-- Global daily budget (weighted average)
+-- Per-model estimates
+-- Limit dimension hypotheses (tokens/requests/RPM)
+-- Model category detection (stable/preview)
+-- Temporal pattern analysis
+-- Multiplier hypothesis tracking
+-- Insight generation

GitHub API (github-api.ts)
+-- Premium request usage from billing API
+-- Multi-strategy auth (Copilot token, gh CLI, fallback)
+-- Periodic polling (15-min interval)

Persistence (persistence.ts)
+-- JSONL append + filtered read
+-- Atomic rotation (size/age)
+-- Estimates read/write
+-- Config management
```

## Development

```bash
git clone https://github.com/moodl/opencode-copilot-usage-detector.git
cd opencode-copilot-usage-detector
npm install
npm run build
npm test
```

After code changes:

```bash
npm run build
cd ~/.config/opencode
npm install /path/to/opencode-copilot-usage-detector
# Restart OpenCode
```

## Disclaimer

This project is **not affiliated with, endorsed by, or associated with GitHub, Microsoft, or OpenCode** in any way. It is an independent, community-built tool.

- This plugin observes your local usage patterns and API error responses. It does **not** access any private or undocumented APIs beyond the public GitHub billing endpoints (which require explicit user authorization).
- Rate limit estimates are **empirical approximations**, not official figures. GitHub may change limits at any time without notice.
- The authors assume **no responsibility** for any consequences of using this plugin, including but not limited to: account restrictions, incorrect estimates, missed rate limits, or any impact on your GitHub Copilot service.
- All data collected by this plugin is stored **locally on your machine** and is never transmitted to any external service.

## License

[MIT](LICENSE) -- see [LICENSE](LICENSE) for full text.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. See the license for the complete terms.

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.
