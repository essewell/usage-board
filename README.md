# usage-board

A tiny dashboard for a small external screen. Shows plan usage for Claude, Codex and Kimi, plus OpenRouter spend. One file, no dependencies, needs Node 22+.

```
node usage-board.mjs     # then open http://localhost:7777
launch.bat               # Windows: starts it and opens an 800x480 window on the second monitor
node usage-board.mjs --check   # tiny self-test
```

| Card | Source |
|---|---|
| Claude | `~/.claude/.credentials.json` -> Anthropic's undocumented OAuth usage endpoint (5h and weekly) |
| Codex | Newest rate-limit line in `~/.codex/sessions/**/*.jsonl` (read locally, no network) |
| Kimi | `~/.kimi/credentials/kimi-code.json` -> `api.kimi.com/coding/v1/usages` (response shape unverified) |
| OpenRouter | `OPENROUTER_API_KEY` env var, or a `.env` file next to the script. Spend today/week/month and balance |

Notes:
- It only reads your local login files. It never refreshes tokens, since that could log the CLIs out. If a login has expired, the card says which app to open.
- The Claude endpoint is undocumented and may change.
- Set `PORT` to change the port (default 7777).
- `launch.ps1` picks the non-primary monitor, falls back to the primary, and uses Chrome or Edge.
