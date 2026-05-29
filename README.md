# pi-subagents-http

Pi extension for delegating tasks to remote agents over HTTP. Fork of [pi-subagents](https://github.com/nicobailon/pi-subagents) replacing subprocess spawning with HTTP transport.

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
      "url": "http://researcher:8080",
      "description": "Research agent with web search tools",
      "timeoutMs": 600000
    },
    {
      "name": "coder",
      "url": "http://localhost:8083",
      "description": "Coding agent with full file access"
    }
  ],
  "defaults": {
    "timeoutMs": 300000,
    "pollIntervalMs": 3000
  }
}
```

## Usage

### Delegate to a single agent

```
subagent({ agent: "researcher", task: "Find market data on renewable energy" })
```

### Delegate to multiple agents in parallel

```
subagent({
  tasks: [
    { agent: "researcher", task: "Research competitor pricing" },
    { agent: "coder", task: "Add pricing comparison endpoint" }
  ]
})
```

### List available agents

```
subagent({ action: "list" })
```

### Check run status

```
subagent({ action: "status" })
subagent({ action: "status", id: "abc123" })
```

## Server Contract

Each remote agent must expose:

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/invoke` | POST | `{ task, context?, runId? }` | `202 { runId, status: "accepted" }` |
| `/status/:runId` | GET | — | `200 { runId, state, progress?, partialOutput? }` |
| `/result/:runId` | GET | — | `200 { runId, state, output, error?, usage?, durationMs }` |

States: `running`, `completed`, `failed`.

`/result/:runId` returns 404 if unknown, 409 if still running.

## Architecture

```
Pi Session (orchestrator)
  |
  +- subagent({ agent: "researcher", task: "..." })
      |
      +- POST http://researcher:8080/invoke
      |   +- 202 { runId: "abc123" }
      |
      +- [background polling]
      |   +- GET http://researcher:8080/status/abc123
      |
      +- [on completion]
          +- GET http://researcher:8080/result/abc123
```

## License

MIT
