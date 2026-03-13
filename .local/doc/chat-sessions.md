# Chat Sessions

Persistent, multi-turn conversations managed by the supervisor. Sessions are the core abstraction for all LLM-mediated work in minibot — whether it's a human chatting through the dashboard, or Core requesting a tool be built.

---

## Session Types

A session type describes **what the session is for**, not what model or process backs it. Agents and humans request sessions by role. The supervisor decides how to fulfill them.

| Type | Role | Examples |
|------|------|----------|
| `coder` | Write code, build tools, modify files | "Build me a web scraper tool", "Add error handling to X" |
| `core` | Reasoning, planning, routing, general work | Email triage, task planning, data processing |
| `canary` | Safety analysis, content screening | Code review for injection, content chunk analysis |

These types will evolve. `core` today covers everything from email routing to advanced reasoning — eventually it may split into more specific types. But for now, three types cover the system.

### Type ≠ model

The session type says nothing about which LLM handles it. That's a backend concern the supervisor manages. Today's mapping:

| Type | Backend (today) |
|------|----------------|
| `coder` | Claude Code CLI on the Mac Mini |
| `core` | Qwen 3.5 9B via Ollama (localhost:11434) |
| `canary` | Qwen 2.5 3B via Ollama (localhost:11434) |

Tomorrow, `coder` might run on a gaming PC with a 3060. `core` might upgrade to a bigger model. The point is: nothing upstream cares. Sessions and agents speak in types. The supervisor translates.

---

## Session Lifecycle

```
create(type) → session ID
    │
    ▼
send(message) → streaming response
send(message) → streaming response
    ...
    │
    ▼
close() → archive history
```

### Create

Request a session by type. The supervisor looks up the backend config, spins up whatever is needed (spawn a process, open an HTTP connection, etc.), and returns a session ID.

### Send

Push a message into the session. The backend processes it in the context of the full conversation history. Responses stream back — the supervisor relays chunks to the dashboard via the event bus so the UI updates in real time.

### Close

Tear down the backend (kill subprocess, close connection). Message history is archived. The session ID becomes inactive.

---

## Session Manager

Lives in the supervisor. Responsibilities:

- **Session registry** — tracks all active sessions (ID, type, state, history)
- **Backend registry** — maps session types to backend configs
- **Lifecycle management** — create, route messages, stream responses, close
- **Event emission** — pushes session events (created, message, response chunk, closed) to the event bus for dashboard consumption

```
┌──────────────────────────────────────────┐
│  session manager                         │
│                                          │
│  backend registry                        │
│  ┌────────┬───────────────────────────┐  │
│  │ coder  │ spawn: claude --output-.. │  │
│  │ core   │ http: localhost:1234/...  │  │
│  │ canary │ http: localhost:1234/...  │  │
│  └────────┴───────────────────────────┘  │
│                                          │
│  active sessions                         │
│  ┌──────────┬────────┬────────────────┐  │
│  │ sess-01  │ coder  │ active         │  │
│  │ sess-02  │ canary │ active         │  │
│  │ sess-03  │ core   │ closed         │  │
│  └──────────┴────────┴────────────────┘  │
│                                          │
│  → event bus (session_msg, session_chunk,│
│    session_created, session_closed)      │
└──────────────────────────────────────────┘
```

---

## Backend Configs

A backend config describes **how to talk to the thing**. The session manager uses it to set up and communicate with the underlying LLM or process.

Two backend kinds for now:

### Process backend (e.g., Claude CLI)

Spawns a child process. Communication over stdin/stdout.

```
{
  kind: "process",
  command: "claude",
  args: ["--output-format", "stream-json"],
  cwd: "/path/to/working/directory"
}
```

The process stays alive for the session's lifetime. Messages go in via stdin, structured JSON events come back on stdout.

### HTTP backend (e.g., Ollama)

Calls an OpenAI-compatible chat completions endpoint. Ollama runs as a native daemon on the Mac Mini (localhost:11434), keeps models loaded in memory, and handles concurrent requests. Conversation history is managed by the session manager and sent with each request.

```
{
  kind: "http",
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "qwen2.5:3b",
  stream: true
}
```

### Future backends

Nothing stops us from adding more backend kinds later — a remote machine over SSH, a WebSocket-based inference server, whatever. The session type stays the same; only the backend config changes.

---

## Dashboard Integration

### Chat panel

The chat panel lives in the **bottom half of the left column**, below the supervisor console, separated by a drag-resizable divider.

- **Tab bar** — one tab per active session, labeled by type (e.g., `coder`, `core-1`). Click to switch, x to close.
- **[+] button** — opens a session type picker (coder / core / canary) to create a new session
- **Chat view** — scrollable message history (user and assistant), text input at the bottom
- **Streaming** — assistant responses render in real time as chunks arrive
- **Placeholder** — when no sessions exist, shows a prompt with the [+] button

The supervisor console (top) stays unchanged — it's the system/command view. The chat panel (bottom) is the conversation view. Two different concerns, stacked vertically.

### Event types

New events on the event bus for dashboard consumption:

| Event | Data |
|-------|------|
| `session_created` | session ID, type |
| `session_message` | session ID, role (user/assistant), content |
| `session_chunk` | session ID, content delta (for streaming) |
| `session_closed` | session ID |
| `state_sync` | full snapshot of active sessions + message history |

These flow through the existing WebSocket connection to the browser, same as ops/work events today.

### State sync on reconnect

Session state survives browser refreshes. When a new WebSocket client connects, the dashboard server calls a snapshot function (injected by the supervisor) that returns all active sessions with their full message history. This is sent as a single `state_sync` event before any live events.

The dashboard server doesn't import or know about the session manager — it receives a `() => StateSnapshot` function via dependency injection. This keeps the server as a pure transport layer. The snapshot approach extends naturally: when other state needs syncing on reconnect (e.g., container status), the snapshot function grows without the server changing.

Note: sessions only survive browser refresh, not supervisor restart. The session manager holds state in memory. Persistence across restarts is a future concern.

---

## Bootstrapping (Now)

Before the full automated pipeline exists, the human uses the dashboard chat to do what Core will eventually do:

1. Create a `coder` session from the dashboard
2. Chat with it — "build a tool that parses RSS feeds"
3. Watch it work in real time (streaming tool use, file edits, etc.)
4. Review the output, ask follow-ups in the same session
5. Manually move the result to where Core will use it
6. Close the session

This is real usage of real infrastructure. The session system being used manually today is the same one the automated pipeline uses later.

---

## Automated Pipeline (Future)

When Core is running and can request tools:

```
Core                    Supervisor              Coder Session         Canary Session
 │                         │                         │                     │
 │  tool_request(spec)     │                         │                     │
 │────────────────────────▶│                         │                     │
 │                         │  create(coder)           │                     │
 │                         │────────────────────────▶│                     │
 │                         │  send(spec)              │                     │
 │                         │────────────────────────▶│                     │
 │                         │         ...works...      │                     │
 │                         │◀────────────────────────│                     │
 │                         │  close()                 │                     │
 │                         │────────────────────────▶│                     │
 │                         │                         │                     │
 │                         │  create(canary)          │                     │
 │                         │─────────────────────────────────────────────▶│
 │                         │  send(code for review)   │                     │
 │                         │─────────────────────────────────────────────▶│
 │                         │         ...analyzes...   │                     │
 │                         │◀─────────────────────────────────────────────│
 │                         │  close()                 │                     │
 │                         │─────────────────────────────────────────────▶│
 │                         │                         │                     │
 │                         │  → dashboard: approve?   │                     │
 │                         │  ← human: approved       │                     │
 │                         │                         │                     │
 │  tool_response(code)    │                         │                     │
 │◀────────────────────────│                         │                     │
```

Same sessions, same backends, same dashboard visibility. The only difference is who initiates: human or Core.
