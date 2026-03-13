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
- **Ingest** (`src/host/ingest/`) — content ingestion pipelines (email, web) producing structured JSON envelopes
- **Canary** (`src/host/canary/`) — content safety evaluation: code tools → LLM classification pipeline
- **Trust** (`src/host/trust/`) — persistent fit_value store for source trustworthiness, file-backed in `.local/data/`

## Models (via Ollama)

- **CORE** — Gemma 3 4B (`gemma3:4b`, Q4_K_M, ~3GB). Routing, triage, summarization, and decision-making for the primary agent loop. Replaced Qwen 3.5 9B after model eval (2026-03-11) — better routing quality at 30x faster TTFT.
- **Canary** — Qwen 2.5 3B (`qwen2.5:3b`, Q4_K_M, ~2.4GB). Injection detection in the safety/honeypot VM. Tight prompt, flag-anything-weird mode.
- **Coder** — Claude Code CLI. Code generation and tool building (not served by Ollama).

Both models run on the host via Ollama as a native daemon (~5.4GB combined). Containers have no direct model access — all inference requests flow through the supervisor's session manager, which routes to the appropriate backend and logs everything.

## Git

You can commit and push to main freely — no need to ask first. Keep commits small and descriptive.

## Locale

This is a local home assistant, not a cloud service. All timestamps, logs, and user-facing times should be in **US Pacific** (America/Los_Angeles). No UTC unless talking to an external API that requires it.

## LLM Output Safety Rules

Code that processes LLM responses must be **deterministic and inert**. The LLM is untrusted input — treat its output like user-submitted form data.

- **No `eval()`, no `Function()`, no dynamic `require()/import()`** based on LLM output
- **No shell exec** where any part of the command is derived from LLM output
- **No path construction** from LLM output (log filenames, file writes, requires)
- **No template interpolation** of LLM output into code, commands, or prompts for other models
- **No dynamic dispatch** — don't use LLM output as keys to look up functions to call
- **JSON.parse() is the boundary.** LLM returns a string → parse it → read known fields → done. If parse fails, error and move on.
- **The canary pipeline must stay dumb.** It makes structured LLM calls, reads the response, packages results. That's it. No autonomy, no tool use, no side effects beyond returning data to the supervisor.

The container is belt-and-suspenders. The real containment is the code itself being non-dynamic. If this rule holds, prompt injection in an email can confuse the LLM's *answer* but cannot make the *code* do anything it wasn't already going to do.

## Key Conventions

- Single HTML file for the dashboard — all CSS and JS inline, no build tools
- Two channels per VM: **ops** (heartbeats, control) and **work** (requests, responses)
- Length-prefixed framing: 4-byte big-endian uint32 + UTF-8 JSON
- Primary container is named "core"
- Security: no docker.sock in containers, no network by default, supervisor mediates all external access
- Web UI preferred over TUI — needs to work on iPad over local network
- Larger font sizes (+2px from defaults)

## Detailed Docs

- `.doc/content-vocabulary.md` — JSON vocabulary for content ingestion, canary tool contracts, trust store integration
- `.doc/email-ingest-findings.md` — batch run findings from 1521 real emails
- `.doc/supervisor-dashboard.md` — full dashboard design, future architecture vision, Canary VM concept
- `.doc/chat-sessions.md` — session abstraction, types vs backends, lifecycle, dashboard integration
- `.doc/progress-2026-03-08.md` — build log with technical details
- `.doc/container-runtimes.md` — runtime-specific notes (Apple Containers vs Docker)
- `.doc/agent-capabilities.md` — (planned) per-VM capability manifests, how supervisor shapes each agent's world view
- `.doc/progress-2026-03-11.md` — threat model brainstorm: injection paths, canary containment, coder-as-gatekeeper
- `.doc/task-core-model-eval.md` — CORE model eval results: gemma3:4b selected over 7 candidates
