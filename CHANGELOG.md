# Changelog

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
