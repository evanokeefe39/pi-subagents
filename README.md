# pi-subagents-http

Pi extension for delegating tasks to remote agents over HTTP. Fork of [pi-subagents](https://github.com/nicobailon/pi-subagents) replacing subprocess spawning with HTTP transport.

Blocks until the remote agent completes by default — no polling loops needed. Parallel delegation runs concurrently and returns all results together.

## Why

pi-subagents spawns child Pi processes on the same machine. This fork delegates to remote agents running as HTTP services — typically Docker containers with their own dependencies, models, and tools.

Use cases:
- Host Pi session orchestrating containerized agents with isolated dependencies
- Multiple orchestrator sessions coordinating shared agent pools
- Agents running on different machines or cloud infrastructure

## Install

```bash
pi install pi-subagents-http
```

Or add to your Pi settings:
```json
{
  "packages": ["pi-subagents-http"]
}
```

## Configure

Create `~/.pi/agent/extensions/subagent-http/config.json`:

```json
{
  "agents": [
    {
      "name": "researcher",
      "url": "http://localhost:8082",
      "description": "Optional fallback if /describe unavailable",
      "timeoutMs": 600000,
      "heartbeat": false,
      "transport": "sse"
    }
  ],
  "defaults": {
    "timeoutMs": 300000,
    "pollIntervalMs": 3000,
    "heartbeatIntervalMs": 30000,
    "transport": "sse"
  },
  "commands": {
    "enabled": true,
    "aliases": {
      "re": "researcher",
      "wr": "writer"
    }
  },
  "shortcuts": {
    "ctrl+1": "planner",
    "ctrl+2": "researcher",
    "ctrl+3": "writer"
  }
}
```

Per-agent options: `timeoutMs` (override default), `heartbeat: false` (disable health monitoring), `transport` (`"sse"` or `"poll"`).

## Usage

### Single delegation (blocking)

```
subagent({ agent: "researcher", task: "Find market data on renewable energy" })
```

Blocks until complete. Returns the agent's full output, usage stats, and model info.

### Parallel delegation (blocking)

```
subagent({
  tasks: [
    { agent: "researcher", task: "Research competitor pricing" },
    { agent: "writer", task: "Draft pricing comparison summary" }
  ]
})
```

All tasks dispatch concurrently. Blocks until ALL complete. Returns combined results.

### Async delegation (fire-and-forget)

```
subagent({ agent: "researcher", task: "Long research task", async: true })
subagent({ action: "status", id: "abc123" })
```

### Custom poll interval

```
subagent({ agent: "data", task: "Run ETL job", pollIntervalMs: 30000 })
```

Default: adaptive backoff (2s → 5s → 10s → 30s).

### Management

```
subagent({ action: "list" })                  // agents + health status
subagent({ action: "status" })                 // all tracked runs
subagent({ action: "status", id: "abc123" })   // specific run
subagent({ action: "cancel", id: "abc123" })   // cancel running task
```

### Slash commands

Each configured agent is automatically registered as a pi slash command:

```
/researcher find local businesses with good reviews and no website
/writer create a professional 3-page report from this research
/planner deep research this topic and produce a final deliverable
```

Commands bypass the LLM — input goes directly to the named agent. Results are injected into the conversation when the agent completes.

**Aliases** shorten frequently-used commands:

```json
{
  "commands": {
    "aliases": {
      "re": "researcher",
      "wr": "writer",
      "pl": "planner"
    }
  }
}
```

Then `/re find local businesses...` works identically to `/researcher find local businesses...`.

Disable commands globally with `"commands": { "enabled": false }`.

### Keyboard shortcuts

Bind keys to send the current editor text to an agent:

```json
{
  "shortcuts": {
    "ctrl+1": "planner",
    "ctrl+2": "researcher",
    "ctrl+3": "writer"
  }
}
```

Type a task in the editor, press the shortcut — the editor clears and the task is dispatched to the agent.

## Server Contract

Each remote agent must expose:

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/invoke` | POST | `{ task, context?, traceparent?, correlationId? }` | `202 { runId, status: "accepted" }` |
| `/status/:runId` | GET | — | `200 { runId, state, startedAt, durationMs, progress }` |
| `/result/:runId` | GET | — | `200 { runId, state, output, error?, usage?, durationMs, model? }` |
| `/cancel/:runId` | POST | — | `200 { runId, state: "cancelled" }` |
| `/describe` | GET | — | `200 { name, description, role, model, tools, extensions, status }` |
| `/health` | GET | — | `200 { status: "ok" }` |

States: `queued`, `running`, `completed`, `failed`, `timeout`, `cancelled`.

`/result/:runId` returns 404 if unknown, 409 if still running.

### Transport

The extension connects to `GET /events` (SSE) on first delegation for real-time completion notifications. If the server doesn't support SSE, it falls back to adaptive polling automatically.

Override per-agent or globally:

```json
{
  "defaults": { "transport": "sse" },
  "agents": [
    { "name": "legacy-agent", "url": "http://...", "transport": "poll" }
  ]
}
```

## Architecture

```
Pi Session (orchestrator)
  │
  └─ subagent({ agent: "researcher", task: "..." })
      │
      ├─ POST /invoke → 202 { runId }
      │
      ├─ [SSE: GET /events — real-time completion notification]
      │   └─ fallback: adaptive polling GET /status/:runId
      │
      ├─ GET /result/:runId → { output, usage, model }
      │
      └─ returns full result to LLM (one tool call, one result)
```

## License

MIT
