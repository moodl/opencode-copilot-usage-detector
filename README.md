# opencode-copilot-usage-detector

An OpenCode plugin that tracks GitHub Copilot token usage across sessions, empirically learns rate limits, and proactively informs you before you hit them.

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
- **Full error catalog** — Logs all API errors for pattern analysis

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

If you already have other plugins, just add it to the array:

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

### Development Install

For local development, install from a cloned repo:

```bash
git clone https://github.com/moodl/opencode-copilot-usage-detector.git
cd opencode-copilot-usage-detector
npm install && npm run build

cd ~/.config/opencode
npm install /path/to/opencode-copilot-usage-detector
```

After code changes, rebuild and reinstall:

```bash
# In the plugin repo
npm run build

# In the OpenCode config dir
cd ~/.config/opencode
npm install /path/to/opencode-copilot-usage-detector
```

Then restart OpenCode to pick up changes.

## Usage

The plugin works automatically — no action needed. It:

1. Tracks every LLM request via event hooks
2. Injects budget status into the system prompt
3. Notifies you in chat when approaching estimated limits
4. Logs everything to `~/.config/copilot-budget/observations.jsonl`

### Budget Tool

Use the `budget` tool (or `/budget` slash command) for detailed information:

- **`/budget status`** — Current usage, estimates, model breakdown
- **`/budget history`** — Daily token usage for the last 14 days
- **`/budget insights`** — Learned patterns, limit estimates, temporal analysis
- **`/budget errors`** — Rate limit events and error catalog
- **`/budget recompute`** — Force recompute all estimates from observations

## Configuration

Create `~/.config/copilot-budget/config.json`:

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

All fields are optional — sensible defaults are used.

### Configuration Fields

| Field | Description | Default |
|-------|-------------|---------|
| `debug` | Log all events to `debug-events.jsonl` | `false` |
| `copilot_plan` | Your Copilot plan (pro, business, enterprise) | `"pro"` |
| `known_preview_models` | Models to always treat as preview | `[]` |
| `known_stable_models` | Models to always treat as stable | `[]` |
| `notification_thresholds` | Percentage thresholds for chat warnings | `[60, 80, 95]` |
| `premium_request_multipliers` | Model cost multipliers | `{}` |
| `quiet_mode` | Suppress threshold notifications | `false` |

## Data Storage

All data is stored in `~/.config/copilot-budget/`:

- `observations.jsonl` — Append-only event log (source of truth)
- `estimates.json` — Derived limit model (can be regenerated)
- `config.json` — User configuration
- `debug-events.jsonl` — Debug event log (when `debug: true`)

The JSONL file auto-rotates at 50MB or when entries are older than 90 days.

## How It Learns

1. **Aggregation** — Every LLM response's token counts are recorded per model per day
2. **Error detection** — API errors (especially HTTP 429) are captured with full context including response headers
3. **Classification** — A 5-stage classifier determines if an error is a burst limit, preview limit, or daily limit
4. **Estimation** — Weighted averages with 14-day half-life produce limit estimates with confidence scores
5. **Insight generation** — After accumulating data, the system identifies patterns (e.g., "opus-heavy days hit limits 2h earlier")

## Architecture

```
Plugin Entry (copilot-budget.ts)
├── Event Handler (message.updated, session.error)
├── chat.params Hook (model/provider capture)
├── System Prompt Injection
├── Session Compaction Context
└── Budget Tool

Aggregator (aggregator.ts)
├── Token + Request counting
├── RPM tracking
├── Day rollover + recovery detection
└── Startup recovery from JSONL

Classifier (classifier.ts)
├── Stage 1: Error message pattern matching
├── Stage 2: Cross-model correlation
├── Stage 3: Cancel-rate analysis
├── Stage 4: Global budget comparison
├── Stage 5: Recovery-time classification
└── Delayed reclassification (10-min timer)

Estimator (estimator.ts)
├── Global daily budget (weighted average)
├── Per-model estimates
├── Limit dimension hypotheses (tokens/requests/RPM)
├── Model category detection (stable/preview)
├── Temporal pattern analysis
├── Multiplier hypothesis tracking
└── Insight generation

Persistence (persistence.ts)
├── JSONL append + filtered read
├── Auto-rotation (size/age)
├── Estimates read/write
└── Config management
```

## License

MIT
