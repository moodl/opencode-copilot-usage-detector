# Changelog

## 0.1.3 (2026-03-21)

### Features
- Toast notifications — rate limit, model blocked, and budget threshold alerts now use non-intrusive TUI toasts instead of conversation messages
- Subagent session skip — system prompt injection is suppressed for subagent sessions (saves tokens)
- Config validation — validates types on startup, warns on unknown keys, falls back to defaults for invalid values
- `/budget clean fake_hits` — removes limit_hit entries from models with no usage (blocked models misrecorded as rate limits)
- Retroactive blocked detection — old limit_hit entries from models with no usage are rerouted to blocked models on recovery

### Improvements
- Extract `handled()` sentinel helper (ecosystem standard pattern from opencode-quota/DCP)
- Add `predicate` filter support to `removeObservations()`
- Add `exports` and `engines` fields to package.json
- Subagent detection result is cached per session (avoids repeated API calls)

## 0.1.1 (2026-03-21)

### Features
- `/budget reset` — wipe today's data and start fresh
- `/budget clean [target]` — selectively remove entries (errors, blocked, limit_hits, model, before date)
- Model blocked detection — identifies models not available on your plan (403/access denied)
- Blocked models shown in status, system prompt, and insights

### Fixes
- Fix command injection: use `execFileSync` instead of `execSync` (github-api.ts)
- Fix cross-session model tracking: per-session Map instead of global variables
- Fix half-life formula: correct 14-day decay using `ln(2)`
- Fix division by zero in preview warning when `ownLimit.value` is 0
- Fix `checkThresholds` mutating source config array
- Fix JSONL rotation: atomic writes via temp file with rollback on failure
- Fix `toLocaleDateString` validation for minimal-ICU Node.js builds
- Fix `day_end` timestamp: drop hardcoded `Z` suffix for timezone consistency
- Fix `sessionModels` Map: TTL-based pruning prevents unbounded growth
- Fix reclassification timers: `unref()` so they don't block process exit
- Fix test glob for CI: use `find` for cross-platform compatibility

### Infrastructure
- GitHub Actions CI (Node 18/20/22)
- npm publish via trusted publishing on GitHub release
- 144 tests across 8 test files
- npm/CI/license badges in README

## 0.1.0 (2026-03-21)

Initial release.

### Features
- Token and request tracking per day/model with RPM monitoring
- 5-stage rate-limit classifier (burst, preview, daily)
- Adaptive limit estimator with confidence scoring and 14-day decay
- System prompt injection with budget status on every LLM turn
- `/budget` slash command (status, history, insights, errors, recompute)
- GitHub billing API integration for premium request tracking
- Preview model auto-detection
- Temporal pattern analysis and insight generation
- Model fallback detection
- Configurable threshold notifications (60%, 80%, 95%)
- Timezone-aware day boundaries
- JSONL auto-rotation (50MB / 90 days)
- Debug event logging mode
