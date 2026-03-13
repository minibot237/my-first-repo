# Supervisor Dashboard

A real-time web dashboard served by the supervisor process, providing visibility into container lifecycle, IPC traffic, and system state. Accessible from any device on the local network (iPad, laptop, etc).

---

## The Bigger Picture

The supervisor is not a simple container launcher — it's a **message router and security gateway** managing multiple VMs, each doing different work. The dashboard is the operator's window into all of it.

```
┌───────────────────────────────────────────────────────┐
│  supervisor                                           │
│                                                       │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Agent VM  │  │ Agent VM  │  │ Canary VM        │  │
│  │           │  │           │  │ (honeypot)       │  │
│  │ ops ◄────►│  │ ops ◄────►│  │                  │  │
│  │ work ◄───►│  │ work ◄───►│  │ ops ◄────►       │  │
│  └───────────┘  └───────────┘  │ work ◄───►       │  │
│       │              │         │ fake net, fake    │  │
│       │              │         │ keys, passwords   │  │
│       │              │         └──────────────────┘  │
│  ┌────┴──────────────┴──────────────┐                │
│  │  message router                  │                │
│  │  - session manager               │                │
│  │    (coder/core/canary sessions)  │                │
│  │  - LLM proxy (Ollama :11434)     │                │
│  │  - filtered internet proxy       │                │
│  │  - email fetch + content pipeline│                │
│  │  - timer-driven tasks            │                │
│  └──────────────────────────────────┘                │
│       │                                              │
│  ┌────┴──────────────────────┐                       │
│  │  dashboard (ws + http)    │◄──── iPad / browser   │
│  │  :9100                    │                       │
│  └───────────────────────────┘                       │
└───────────────────────────────────────────────────────┘
```

### Chat sessions

The supervisor manages **chat sessions** — persistent, multi-turn conversations with LLM backends. Sessions are requested by **type** (what the session is for), not by model or endpoint. The supervisor maps types to backends.

| Type | Role | Backend (today) |
|------|------|----------------|
| `coder` | Write code, build tools | Claude Code CLI |
| `core` | Reasoning, planning, routing | Qwen 3.5 9B via Ollama |
| `canary` | Safety analysis, screening | Qwen 2.5 3B via Ollama |

Backends are swappable — agents and humans never specify which model they want, just the session type. The session manager handles lifecycle (create, send, stream, close), maintains conversation history, and emits events to the dashboard over the event bus.

The dashboard exposes a chat interface for creating and interacting with sessions directly. This is the bootstrapping path: the human does manually what Core will eventually do through the work channel.

Full design: [`.local/doc/chat-sessions.md`](chat-sessions.md)

### Two channels per VM

Every VM has two logical channels, separated to keep management traffic out of the work stream:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| **Ops** | Bidirectional | Control commands (supervisor → agent), status/heartbeats (agent → supervisor), lifecycle events |
| **Work** | Bidirectional | Request/response traffic — LLM calls, web fetches, content delivery, task results |

The dashboard shows these as separate streams per VM.

### Content safety pipeline

External content (web pages, emails) flows through a pipeline before reaching agent VMs:

```
raw HTML → code cleanup (strip tags, HTML→markdown) → regex scan → chunk with overlap → Canary VM
```

The Canary VM — named **Canary** — is a **honeypot sandbox**: a small local model (Qwen 2.5 3B via Ollama on the host) wrapped in a prompt that treats each content chunk as potentially hostile. The VM has fake high-value targets — bitcoin key files, passwords.txt, a fake network stack that captures traffic. The supervisor watches the agent's *behavior*: does it try to read the fake keys? Does it try to exfiltrate over the fake network? If it triggers, the VM is frozen for later forensic inspection.

This is all future scope — documented here so the dashboard design accounts for it.

---

## Goals

- See what every container is doing, in real time, across both channels
- Inspect IPC messages flowing through each container's ops and work sockets
- Filter and search message streams by type, channel, container, payload content
- Focus on a single container for detailed inspection without losing the overview
- Surface safety events prominently — trap triggers, captured exfiltration, frozen VMs
- Zero external build tools — single HTML file, no bundler, no framework

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  supervisor process (Node.js)                │
│                                              │
│  ┌──────────────┐    ┌────────────────────┐  │
│  │ runtime mgr  │───▶│ event bus          │  │
│  │ (containers) │    │ (EventEmitter)     │  │
│  └──────────────┘    └──┬──────────┬──────┘  │
│                         │          │         │
│                  ┌──────┴──┐  ┌────┴──────┐  │
│                  │ ws srv  │  │ http srv  │  │
│                  │ :9100   │  │ :9100     │  │
│                  └─────────┘  └───────────┘  │
│                                              │
└──────────────────────────────────────────────┘
         │                        │
    WebSocket                  GET /
         │                        │
    ┌────┴────────────────────────┴────┐
    │  browser (iPad / laptop / etc)   │
    │  single-page dashboard           │
    └─────────────────────────────────┘
```

### Data flow

1. Container runtimes emit events to a central event bus, tagged with channel (ops/work) and container ID
2. The WebSocket server broadcasts each event to all connected dashboard clients
3. The browser receives events and updates the UI in real time
4. The browser sends commands back (nudge, stop, filter) over the same WebSocket

### Server components

All served from the supervisor process — no separate server:

- **`node:http`** — serves the static HTML dashboard on `GET /`
- **`ws`** — upgrades HTTP connections to WebSocket for real-time streaming
- **Event bus** — internal `EventEmitter` that the runtime manager and WebSocket server both connect to

Single port (default `9100`), shared between HTTP and WebSocket.

---

## Layout

Two-column layout, full viewport height. Left column is split vertically into supervisor console (top) and chat sessions (bottom) with a drag-resizable divider.

```
┌─────────────────────┬──────────────────────────────────┐
│ supervisor console   │  VM 1 (agent-abc)                │
│                     │  ● running                       │
│ > nudge agent-abc   │  ops: ♥ 2s ago                   │
│ [nudge sent]        │  work: > web_fetch < content     │
│ > status            │──────────────────────────────────│
│ > _                 │  VM 2 (agent-def)                │
├─────────────────────│  ● running                       │
│ [coder] [core] [+]  │  ops: ♥ 1s ago                   │
│                     │  work: > llm_call < llm_response │
│ you: build me a     │──────────────────────────────────│
│ tool that parses    │  VM 3 (canary)                   │
│ RSS feeds           │  ● running                       │
│                     │  ops: ♥ 1s ago                   │
│ assistant: I'll     │  work: checking chunk 3/7...     │
│ create a...         │                                  │
│ > _                 │                                  │
└─────────────────────┴──────────────────────────────────┘
```

### Left column (~30% width)

Split into two sections with a vertical resize handle between them.

#### Top: Supervisor console

- Text input at the bottom for commands
- Scrollable output log above it
- Receives supervisor-level events (container started, stopped, errors, safety alerts)
- No tabs — single persistent view
- Commands:
  - `nudge <id>` — send a nudge to an agent's control channel (trigger a contrived work request for testing)
  - `filter <pattern>` — filter messages across all VMs
  - `status` — show all container states
  - `clear` — clear the log
  - Future: `stop <id>`, `freeze <id>`, `restart <id>`

#### Bottom: Chat sessions

- **Tab bar** across the top with one tab per active session
  - Each tab shows the session type as label (e.g., `coder`, `core-1`, `canary-2`)
  - Click tab to switch between sessions
  - Close button (x) on each tab
  - **[+] button** opens a session type picker (coder / core / canary) to create a new session
- **Chat view** below the tab bar
  - Scrollable message history (user and assistant messages)
  - Text input at the bottom for sending messages
  - Streaming responses render in real time as chunks arrive
- When no sessions exist, shows a placeholder with the [+] button
- This is the bootstrapping interface: the human interacts with sessions directly, doing what Core will eventually automate

### Right column: VM panel grid (~70% width)

- Stacked rows, one per active container
- Each row shows:
  - Container ID (short) and role (agent / safety)
  - Status indicator (running / stopped / frozen / alert)
  - **Ops line**: last heartbeat, control events
  - **Work line**: last few work messages, direction indicated
- Messages are color-coded by type and channel
- Rows auto-appear when containers start, dim when stopped
- Canary VM row highlighted differently — alert state turns red

### Focus mode

Click a VM row to expand it to full height of the right column:

```
┌─────────────────────┬──────────────────────────────────┐
│ supervisor console   │  VM 1 (agent-abc)  [x]           │
│ > status            │  ● running                       │
│ > _                 │                                  │
├─────────────────────│  ── ops ──────────────────────── │
│ [coder] [core] [+]  │  12:01:03 ♥ heartbeat            │
│                     │  12:01:05 < nudge                │
│ you: build me...    │  12:01:05   { action: "check" }  │
│                     │                                  │
│ assistant: ...      │  ── work ─────────────────────── │
│                     │  12:01:05 > web_fetch            │
│                     │    { url: "..." }                │
│                     │  12:01:06 < content              │
│                     │    { bytes: 4096,                │
│  > _                │      status: "clean" }           │
└─────────────────────┴──────────────────────────────────┘
```

In focus mode:
- Ops and work channels shown as separate scrollable sections
- Full message payloads expanded (pretty-printed JSON)
- Timestamps on every message
- Click `[x]` or Escape to return to grid view

---

## Filtering

Client-side filtering over the live message stream. No server round-trip.

- **By channel:** `filter channel:ops` or `filter channel:work`
- **By message type:** `filter type:hello`
- **By container:** `filter vm:abc`
- **By payload content:** `filter payload:minibot`
- **Combined:** `filter channel:work type:hello vm:abc`
- **Clear:** `filter` (no args) resets to show all

---

## WebSocket Protocol

### Server → Client

```typescript
interface DashboardEvent {
  kind: "container_start" | "container_stop" | "ops" | "work_in" | "work_out" | "error" | "alert"
      | "session_created" | "session_message" | "session_chunk" | "session_closed";
  containerId: string;  // container ID for VM events, session ID for session events
  timestamp: string;
  data: unknown;
}
```

**`ops`** — heartbeats, status updates, control acks:
```json
{ "kind": "ops", "containerId": "abc", "timestamp": "...",
  "data": { "type": "heartbeat", "uptime": 120 } }
```

**`work_in`** — agent → supervisor work request:
```json
{ "kind": "work_in", "containerId": "abc", "timestamp": "...",
  "data": { "type": "web_fetch", "id": "uuid", "payload": { "url": "..." } } }
```

**`work_out`** — supervisor → agent work response:
```json
{ "kind": "work_out", "containerId": "abc", "timestamp": "...",
  "data": { "type": "content", "id": "uuid", "payload": { "body": "..." } } }
```

**`alert`** — safety VM triggered:
```json
{ "kind": "alert", "containerId": "canary", "timestamp": "...",
  "data": { "trigger": "file_access", "path": "/fake/passwords.txt", "frozen": true } }
```

**`session_created`** — new chat session opened:
```json
{ "kind": "session_created", "containerId": "sess-01", "timestamp": "...",
  "data": { "type": "coder" } }
```

**`session_message`** — complete message added to session (user or assistant):
```json
{ "kind": "session_message", "containerId": "sess-01", "timestamp": "...",
  "data": { "role": "user", "content": "build me a tool that parses RSS" } }
```

**`session_chunk`** — streaming response delta:
```json
{ "kind": "session_chunk", "containerId": "sess-01", "timestamp": "...",
  "data": { "content": "I'll create" } }
```

**`session_closed`** — session ended:
```json
{ "kind": "session_closed", "containerId": "sess-01", "timestamp": "...",
  "data": {} }
```

### Client → Server

```typescript
interface DashboardCommand {
  action: "nudge" | "stop" | "freeze" | "session_create" | "session_send" | "session_close";
  containerId: string;  // container ID for VM commands, session ID for session commands
  data?: unknown;
}
```

**Session commands:**

- `session_create` — create a new session. `data: { type: "coder" | "core" | "canary" }`. Server responds with `session_created` event containing the assigned session ID.
- `session_send` — send a message to an active session. `containerId` is the session ID. `data: { content: "..." }`. Server responds with `session_message` (for the user message echo) followed by streaming `session_chunk` events, then a final `session_message` (for the complete assistant response).
- `session_close` — close a session. `containerId` is the session ID. Server responds with `session_closed` event.

---

## Implementation Plan

### New dependencies

- **`ws`** — WebSocket server. Lightweight, no sub-dependencies.

### Files

```
src/
  host/
    sessions/
      manager.ts      # Session registry, lifecycle, backend dispatch
      backends/
        process.ts    # Child process backend (e.g., Claude CLI)
        http.ts       # HTTP chat completions backend (e.g., Ollama)
      types.ts        # Session, BackendConfig, SessionEvent types
    dashboard/
      server.ts       # HTTP + WebSocket server, event bus integration
      events.ts       # DashboardEvent types, event bus
    dashboard-ui/
      index.html      # single-file dashboard (HTML + CSS + JS inline)
  shared/
    protocol.ts       # updated: ops + work message types, channel tagging
```

### Integration

1. Add `EventBus` to the supervisor
2. Tag every message with its channel (ops/work) and container ID
3. Dashboard server subscribes to bus, forwards to WebSocket clients
4. Dashboard client renders two-channel view per VM
5. Session manager subscribes to session commands from the bus, emits session events back
6. Dashboard client renders chat panel with tabs, session type picker, streaming responses

---

## Styling

- Dark background (`#1a1a2e`) — good contrast, easy on the eyes
- Monospace font for payloads
- Color coding:
  - Green: heartbeats, acks, successful events
  - Blue: work traffic (requests/responses)
  - Yellow: ops control commands
  - Red: errors, safety alerts, frozen VMs
  - Gray: timestamps, metadata
- Responsive: works on iPad (portrait + landscape) and desktop

---

## Tonight's Demo Target

Get the dashboard rendering live traffic from a dumb agent. Not the full system — just enough to see the two-channel model working and the UI updating in real time.

The agent:
- Sends periodic status on the **ops channel** (heartbeat every few seconds)
- Responds to a **nudge** command from the supervisor (via dashboard) by sending a contrived work request on the **work channel** (e.g., a fake `web_fetch` request)
- Supervisor responds with a canned work response

What you see on the dashboard:
- One VM panel with ops heartbeats ticking
- Type `nudge <id>` in the command panel
- Work channel lights up with the request/response
- Focus mode shows the full payloads

This is still hello-world-level container work. The agent is dumb. But the dashboard, event bus, two-channel protocol, and WebSocket plumbing are all real infrastructure that scales to the full system.

---

## Not in scope (for now)

- Authentication — local network tool, no auth yet
- Persistent message history — browser memory only
- Canary VM implementation — dashboard will have the section ready
- Content pipeline — future
- LLM proxy — future (partially covered by session backends)
