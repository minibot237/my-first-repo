# Minibot

A container-based agent system being built on a dedicated M4 Mac Mini. The machine has one job: be minibot.

## What's happening here

This repo is being bootstrapped in real time by a developer and an AI agent (Claude) working together through [Claude Code](https://claude.com/claude-code). The dev drives direction and makes decisions; the agent writes code, explores ideas, and builds things out. It's iterative, conversational, and demo-driven — we talk through what we want, then build it.

The commit history is the build log. We started from zero on March 8, 2026.

## What minibot is

A supervisor process on the Mac Mini manages lightweight Linux containers. Each container runs an agent. The supervisor and agents communicate over IPC (no network access in containers by default) using a simple length-prefixed JSON protocol. A real-time web dashboard shows what's happening.

```
┌──────────────────────────────────────────┐
│  Mac Mini (host)                         │
│                                          │
│  ┌──────────────┐    ┌────────────────┐  │
│  │  Supervisor   │◄──►│  Dashboard UI  │  │
│  │  (Node.js)    │    │  :9100         │  │
│  └──┬───────┬────┘    └────────────────┘  │
│     │       │                             │
│     │ IPC   │ IPC                         │
│     │       │                             │
│  ┌──┴──┐ ┌──┴──┐                         │
│  │ VM  │ │ VM  │  ...                     │
│  │agent│ │agent│                          │
│  └─────┘ └─────┘                          │
└──────────────────────────────────────────┘
```

Two container runtimes are supported behind a common interface:
- **Apple Containers** — lightweight macOS-native VMs via the `container` CLI
- **Docker** — standard Docker containers

## What works today

- Supervisor boots containers, establishes two IPC channels per VM (ops + work)
- Agents send hello messages and heartbeats over the ops channel
- Web dashboard with live WebSocket updates, drag-resizable panels, heartbeat filtering
- Both Apple Containers and Docker runtimes

## Where it's going

- Supervisor as a message router and security gateway
- Safety VM with honeypot sandbox and injection detection
- Content pipeline for processing and sanitizing inputs
- LLM proxy to local models via LM Studio

## Running it

```bash
npm install
npx tsc
cp -r dist/shared dist/container container-image/
cp src/host/dashboard-ui/index.html dist/host/dashboard-ui/
RUNTIME=docker node dist/host/supervisor.js
```

Dashboard at http://localhost:9100

## Tech

TypeScript (Node.js) on both sides. Single-file HTML dashboard — no bundler, no framework. Length-prefixed JSON over unix sockets / vsock. See [CLAUDE.md](CLAUDE.md) for conventions and architecture details.

## License

Free to use for personal and non-commercial purposes. If you want to use this work commercially or make money with it, reach out first. See [LICENSE](LICENSE) for details.
