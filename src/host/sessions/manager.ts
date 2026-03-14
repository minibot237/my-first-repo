import { randomUUID } from "node:crypto";
import { bus } from "../dashboard/events.js";
import { streamChatCompletion, type ChatMessage, type HttpBackendConfig } from "./http-backend.js";
import { ClaudeSession, type ProcessBackendConfig } from "./process-backend.js";
import { localTimestamp, SessionLog, log as slog } from "../log.js";

export type SessionType = "coder" | "core" | "canary" | "chat" | "agent";
export type SessionState = "active" | "closed";

export interface SessionBackendInfo {
  source: string;  // "ollama" | "claude"
  model: string;   // "qwen3.5:latest" | "claude" etc.
}

export interface Session {
  id: string;
  type: SessionType;
  state: SessionState;
  messages: ChatMessage[];
  abortController: AbortController | null;
  backend: SessionBackendInfo;
  claudeSession: ClaudeSession | null;
  log: SessionLog;
}

type BackendConfig = HttpBackendConfig | ProcessBackendConfig;

const BACKEND_CONFIGS: Record<SessionType, BackendConfig> = {
  core: {
    kind: "http",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "gemma3:4b",
    stream: true,
  },
  canary: {
    kind: "http",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "qwen2.5:3b",
    stream: true,
  },
  coder: {
    kind: "process",
    model: "claude-sonnet-4-6",
  },
  chat: {
    kind: "process",
    model: "claude-sonnet-4-6",
  },
  agent: {
    kind: "process",
    model: "claude-sonnet-4-6",
  },
};

function backendInfo(config: BackendConfig): SessionBackendInfo {
  if (config.kind === "process") {
    return { source: "claude", model: "claude" };
  }
  return { source: "ollama", model: config.model };
}

function emitSession(kind: string, data: unknown) {
  bus.emit("dashboard", {
    kind,
    containerId: "_sessions",
    timestamp: localTimestamp(),
    data,
  });
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(type: SessionType): Session {
    const id = "sess-" + randomUUID().slice(0, 8);
    const config = BACKEND_CONFIGS[type];
    const backend = backendInfo(config);
    const sessionLog = new SessionLog(type, id);
    slog("sessions", `created ${type} session`, { sessionId: id, backend });
    const session: Session = {
      id,
      type,
      state: "active",
      messages: [],
      abortController: null,
      backend,
      claudeSession: config.kind === "process" ? new ClaudeSession(config) : null,
      log: sessionLog,
    };
    this.sessions.set(id, session);
    emitSession("session_created", { sessionId: id, type, backend });
    return session;
  }

  async send(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "closed") return;

    const config = BACKEND_CONFIGS[session.type];
    if (!config) return;

    // Add user message
    session.messages.push({ role: "user", content });
    session.log.user(content);
    emitSession("session_message", { sessionId, role: "user", content });

    // Stream the response
    const abortController = new AbortController();
    session.abortController = abortController;

    let fullResponse = "";
    try {
      const stream = session.claudeSession
        ? session.claudeSession.send(content, abortController.signal)
        : streamChatCompletion(config as HttpBackendConfig, session.messages, abortController.signal);
      for await (const delta of stream) {
        fullResponse += delta;
        emitSession("session_chunk", { sessionId, delta });
      }

      // Add assistant message to history
      session.messages.push({ role: "assistant", content: fullResponse });
      session.log.assistant(fullResponse);
      emitSession("session_message", { sessionId, role: "assistant", content: fullResponse });
    } catch (err) {
      const errMsg = (err as Error).message;
      session.log.error(errMsg);
      if ((err as Error).name !== "AbortError") {
        emitSession("session_error", {
          sessionId,
          error: errMsg,
        });
      }
    } finally {
      session.abortController = null;
    }
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.abortController?.abort();
    session.claudeSession?.close();
    session.log.close();
    session.state = "closed";
    emitSession("session_closed", { sessionId });
  }

  closeAll(): void {
    for (const [id, session] of this.sessions) {
      if (session.state === "active") {
        session.abortController?.abort();
        session.claudeSession?.close();
        session.log.close();
        session.state = "closed";
        emitSession("session_closed", { sessionId: id });
      }
    }
    this.sessions.clear();
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Session[] {
    return [...this.sessions.values()].filter((s) => s.state === "active");
  }

  snapshot() {
    return {
      sessions: this.list().map((s) => ({
        id: s.id,
        type: s.type,
        backend: s.backend,
        messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
      })),
    };
  }
}
