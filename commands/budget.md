Use the `budget` tool to check your GitHub Copilot token budget status.

Available actions:
- `status` — Current usage, estimates, and model breakdown
- `history` — Daily token usage for the last 14 days
- `insights` — Learned patterns, limit estimates, temporal analysis
- `errors` — Rate limit events and error catalog
- `recompute` — Force recompute all estimates from observations

Call the budget tool with the appropriate action based on what the user wants to know.
If no specific action is mentioned, default to `status`.
