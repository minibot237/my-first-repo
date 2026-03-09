# Minibot

Container-based agent system on a dedicated M4 Mac Mini (32GB). This machine has one purpose: be minibot. We're building a multi-VM supervisor with a real-time web dashboard, safety pipeline, and LLM proxy.

## Build & Run

```bash
npx tsc                                    # compile TypeScript
cp -r dist/shared dist/container container-image/  # copy to container build context
cp src/host/dashboard-ui/index.html dist/host/dashboard-ui/  # HTML isn't compiled by tsc
RUNTIME=docker node dist/host/supervisor.js        # run with Docker
RUNTIME=apple-containers node dist/host/supervisor.js  # run with Apple Containers
```

Dashboard at http://localhost:9100

## Architecture

- **Supervisor** (`src/host/supervisor.ts`) — message router, container lifecycle (non-blocking pipeline), dashboard integration
- **Agent** (`src/container/agent.ts`) — runs inside container, sends hello/heartbeats, responds to nudges
- **Protocol** (`src/shared/protocol.ts`) — 4-byte length-prefixed JSON, ops/work channels
- **Dashboard** (`src/host/dashboard/`) — HTTP + WebSocket server on :9100, EventEmitter bus
- **Dashboard UI** (`src/host/dashboard-ui/index.html`) — single HTML file, no bundler, no framework
- **Runtimes** (`src/host/runtime/`) — Apple Containers and Docker behind `ContainerRuntime` interface
- **Ollama** (host, :11434) — local LLM inference daemon, supervisor proxies all model access
- **Sessions** (`src/host/sessions/`) — persistent multi-turn chat sessions (coder/core/canary types)

## Models (via Ollama)

- **CORE** — Qwen 3.5 9B (Q4_K_M, ~5-6GB). Routing and decision-making for the primary agent loop.
- **Canary** — Qwen 2.5 3B (Q4_K_M, ~2.4GB). Injection detection in the safety/honeypot VM. Tight prompt, flag-anything-weird mode.
- **Coder** — Claude Code CLI. Code generation and tool building (not served by Ollama).

Both Qwen models run on the host via Ollama as a native daemon. Containers have no direct model access — all inference requests flow through the supervisor's session manager, which routes to the appropriate backend and logs everything.

## Git

You can commit and push to main freely — no need to ask first. Keep commits small and descriptive.

## Key Conventions

- Single HTML file for the dashboard — all CSS and JS inline, no build tools
- Two channels per VM: **ops** (heartbeats, control) and **work** (requests, responses)
- Length-prefixed framing: 4-byte big-endian uint32 + UTF-8 JSON
- Primary container is named "core"
- Security: no docker.sock in containers, no network by default, supervisor mediates all external access
- Web UI preferred over TUI — needs to work on iPad over local network
- Larger font sizes (+2px from defaults)

## Detailed Docs

- `docs/supervisor-dashboard.md` — full dashboard design, future architecture vision, Canary VM concept
- `docs/chat-sessions.md` — session abstraction, types vs backends, lifecycle, dashboard integration
- `docs/progress-2026-03-08.md` — build log with technical details
- `docs/container-runtimes.md` — runtime-specific notes (Apple Containers vs Docker)
- `docs/agent-capabilities.md` — (planned) per-VM capability manifests, how supervisor shapes each agent's world view
