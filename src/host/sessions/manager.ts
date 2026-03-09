import { randomUUID } from "node:crypto";
import { bus } from "../dashboard/events.js";
import { streamChatCompletion, type ChatMessage, type HttpBackendConfig } from "./http-backend.js";

export type SessionType = "coder" | "core" | "canary";
export type SessionState = "active" | "closed";

export interface Session {
  id: string;
  type: SessionType;
  state: SessionState;
  messages: ChatMessage[];
  abortController: AbortController | null;
}

type BackendConfig = HttpBackendConfig;
// Future: | ProcessBackendConfig

const BACKEND_CONFIGS: Record<SessionType, BackendConfig> = {
  core: {
    kind: "http",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "qwen3.5:latest",
    stream: true,
  },
  canary: {
    kind: "http",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "qwen2.5:3b",
    stream: true,
  },
  coder: {
    // Placeholder — coder will eventually be a process backend (Claude CLI)
    // For now, route through Ollama so the UI works end-to-end
    kind: "http",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "qwen3.5:latest",
    stream: true,
  },
};

function emitSession(kind: string, data: unknown) {
  bus.emit("dashboard", {
    kind,
    containerId: "_sessions",
    timestamp: new Date().toISOString(),
    data,
  });
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(type: SessionType): Session {
    const id = "sess-" + randomUUID().slice(0, 8);
    const session: Session = {
      id,
      type,
      state: "active",
      messages: [],
      abortController: null,
    };
    this.sessions.set(id, session);
    emitSession("session_created", { sessionId: id, type });
    return session;
  }

  async send(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "closed") return;

    const config = BACKEND_CONFIGS[session.type];
    if (!config) return;

    // Add user message
    session.messages.push({ role: "user", content });
    emitSession("session_message", { sessionId, role: "user", content });

    // Stream the response
    const abortController = new AbortController();
    session.abortController = abortController;

    let fullResponse = "";
    try {
      for await (const delta of streamChatCompletion(config, session.messages, abortController.signal)) {
        fullResponse += delta;
        emitSession("session_chunk", { sessionId, delta });
      }

      // Add assistant message to history
      session.messages.push({ role: "assistant", content: fullResponse });
      emitSession("session_message", { sessionId, role: "assistant", content: fullResponse });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        emitSession("session_error", {
          sessionId,
          error: (err as Error).message,
        });
      }
    } finally {
      session.abortController = null;
    }
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Abort any in-flight request
    session.abortController?.abort();
    session.state = "closed";
    emitSession("session_closed", { sessionId });
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Session[] {
    return [...this.sessions.values()].filter((s) => s.state === "active");
  }
}
