# opencode-copilot-usage-detector

[![npm version](https://img.shields.io/npm/v/opencode-copilot-usage-detector)](https://www.npmjs.com/package/opencode-copilot-usage-detector)
[![CI](https://github.com/moodl/opencode-copilot-usage-detector/actions/workflows/ci.yml/badge.svg)](https://github.com/moodl/opencode-copilot-usage-detector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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
- **Blocked model detection** — Identifies models not available on your plan (403, access denied, etc.) and separates them from real rate limits
- **Preview model detection** — Automatically identifies models with separate, stricter limits
- **Rate-limit classification** — 5-stage classifier distinguishing burst, preview, and daily limits
- **Toast notifications** — Non-intrusive TUI toasts for rate limits, blocked models, and budget thresholds (doesn't pollute conversation)
- **System prompt injection** — Budget status in every LLM context (zero tool-call overhead, skipped for subagent sessions)
- **Threshold notifications** — Configurable alerts at 60%, 80%, 95% of estimated limits
- **Config validation** — Validates config types on startup, warns on unknown keys
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
npm install opencode-copilot-usage-detector
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
npm install opencode-copilot-usage-detector@latest
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
| `/budget reset` | Wipe today's data and start fresh |
| `/budget clean [target]` | Remove specific entries from the observation log |

#### Clean targets

| Target | Description |
|--------|-------------|
| `errors` | Remove all logged errors |
| `blocked` | Remove all blocked model entries |
| `limit_hits` | Remove all rate limit entries |
| `fake_hits` | Remove limit_hits from models with no usage (misrecorded blocked models) |
| `model <name>` | Remove all entries for a specific model |
| `before <date>` | Remove entries before a date (YYYY-MM-DD) |

### Example: `/budget status`

```
## Copilot Budget Status — 2026-03-21

### Monthly Premium Requests
Premium requests this month: 147 / 300 (49% used, 153 remaining)
  claude-opus-4.5: 89 requests
  gpt-5.4-mini: 58 requests
*Last updated: 2026-03-21T14:30:00Z*

**Total tokens today:** 1.8M
**Total requests today:** 67
**Total cost today:** $0.0000
**Current RPM:** 3 req/min (peak: 7)

**Estimated daily token limit:** ~2.9M (82% confidence)
**Usage:** ~63%
**Limit type:** tokens

### Model Breakdown

| Model            | Tokens | Requests | Category |
|------------------|--------|----------|----------|
| claude-opus-4.5  | 1.4M   | 42       | stable   |
| gpt-5.4-mini     | 422K   | 25       | stable   |
```

### Example: System Prompt Injection

Every LLM response automatically sees this context (no tool call needed):

```xml
<copilot-budget>
Premium requests this month: 147 / 300 (49% used, 153 remaining)
Daily token usage: 1.8M tokens (67 requests)
Estimated daily limit: ~2.9M tokens (confidence: 82%)
Usage percentage: ~63%
Cost today: $0.0000
Current rate: 3 req/min (peak: 7)

Model breakdown:
  claude-opus-4.5: 1.4M tokens / 42 requests (stable)
  gpt-5.4-mini: 422K tokens / 25 requests (stable)
</copilot-budget>
```

### Toast Notifications

Alerts appear as non-intrusive TUI toasts that don't pollute the conversation:

- **Budget warning** — `80% of daily budget used (2.3M / ~2.9M est.)`
- **Rate limited** — `2.8M tokens, 142 req | claude-opus-4.5 | hard_daily_limit`
- **Model blocked** — `claude-opus-4.6 is not available on your plan (status: 403)`

### Example: `/budget insights`

After accumulating data over several days:

```
## Copilot Budget Insights

**Data since:** 2026-03-01
**Days observed:** 21
**Days with limit hit:** 8

### Global Daily Budget
- Token estimate: ~2.9M (+/- 210K)
- Confidence: 82% (8 data points)
- Active limit type: tokens

### Model Categories

| Model            | Category | Source | Confidence | Own Limit | Errors |
|------------------|----------|--------|------------|-----------|--------|
| claude-opus-4.5  | stable   | auto   | 95%        | -         | 5      |
| claude-opus-4.6  | preview  | auto   | 88%        | ~400K     | 4      |
| gpt-5.4-mini     | stable   | auto   | 90%        | -         | 1      |

### Temporal Patterns
- Typical limit time: 16:30
- Std dev: +/- 75 min
- Reset type: daily_fixed
- Estimated reset: 00:00

### Generated Insights
- **[model_impact]** claude-opus-4.5-heavy days hit limits ~2.1h earlier
  than mixed days (75% confidence, 8 data points)
- **[preview_detection]** claude-opus-4.6 has separate preview limit
  (~400K tokens) (88% confidence, 4 data points)
```

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
