import { log } from "../log.js";
import { IdentityRegistry, type TransportIdentity } from "./identity.js";
import {
  ActionRegistry, parseChatResponse,
  type ActionContext, type ChatAction,
} from "./actions.js";
import {
  buildChatSystemPrompt, saveMode, listModes,
  DEFAULT_SESSION_CONFIG, type SessionConfig,
} from "./prompt-builder.js";
import type { Transport } from "./transport.js";
import type { SessionManager } from "../sessions/manager.js";

interface ActiveChat {
  sessionId: string;
  identity: TransportIdentity;
  config: SessionConfig;
  systemPrompt: string;
  firstMessage: boolean;
  transport: string;
  lastMessageAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Routes messages between transports and chat sessions.
 * Handles identity lookup, session lifecycle, response parsing, and action execution.
 */
export class TransportRouter {
  private identities: IdentityRegistry;
  private actions: ActionRegistry;
  private sessions: SessionManager;
  private chats = new Map<string, ActiveChat>();  // identityId → ActiveChat
  private transports = new Map<string, Transport>();

  constructor(identities: IdentityRegistry, actions: ActionRegistry, sessions: SessionManager) {
    this.identities = identities;
    this.actions = actions;
    this.sessions = sessions;

    this.registerBuiltinActions();
  }

  /** Register a transport and wire up its onMessage callback */
  addTransport(transport: Transport): void {
    this.transports.set(transport.name, transport);

    transport.onMessage = (userId: string, text: string) => {
      this.handleIncoming(transport.name, userId, text).catch(err => {
        log("router", "message handling error", { transport: transport.name, userId, error: (err as Error).message });
      });
    };
  }

  /** Start all registered transports */
  async startAll(): Promise<void> {
    for (const [name, transport] of this.transports) {
      try {
        await transport.start();
      } catch (err) {
        log("router", "transport start failed", { name, error: (err as Error).message });
      }
    }
  }

  /** Stop all transports and close all chat sessions */
  stopAll(): void {
    for (const transport of this.transports.values()) {
      transport.stop();
    }
    for (const chat of this.chats.values()) {
      this.closeChat(chat);
    }
  }

  private async handleIncoming(transportName: string, userId: string, text: string): Promise<void> {
    // 1. Identity lookup
    const identity = this.identities.lookup(transportName, userId);
    if (!identity) {
      log("router", "unknown identity, ignoring", { transport: transportName, userId });
      return;
    }

    // 2. Find or create chat session
    const chat = this.findOrCreateChat(identity, transportName);

    // 3. Reset idle timer
    this.resetIdleTimer(chat);

    // 4. Send to session and collect response
    log("router", "incoming", {
      identity: identity.id,
      mode: chat.config.mode,
      contentLength: text.length,
    });

    // The session accumulates the full response via streaming.
    // We need to capture it — send and then read the last assistant message.
    const session = this.sessions.get(chat.sessionId);
    if (!session || session.state === "closed") {
      // Session was closed externally — recreate
      const newChat = this.createChat(identity, transportName, chat.config);
      this.chats.set(identity.id, newChat);
      await this.sendAndReply(newChat, identity, transportName, text);
      return;
    }

    await this.sendAndReply(chat, identity, transportName, text);
  }

  private async sendAndReply(
    chat: ActiveChat,
    identity: TransportIdentity,
    transportName: string,
    text: string,
  ): Promise<void> {
    const transport = this.transports.get(transportName);
    if (!transport) return;

    // Wrap user message with system context
    // The SDK session is Claude Code — it has its own system prompt.
    // We inject our instructions as part of the user message.
    let wrappedMessage: string;
    if (chat.firstMessage) {
      // First message: full system prompt + user message
      wrappedMessage = `<chat-system-instructions>
${chat.systemPrompt}
</chat-system-instructions>

IMPORTANT: You are operating as a chat assistant, NOT as Claude Code. Do NOT use any tools, do NOT read files, do NOT write code. Just respond with the JSON format specified above.

User message: ${text}`;
      chat.firstMessage = false;
    } else {
      // Follow-up messages: brief reminder + user message
      wrappedMessage = `Remember: respond ONLY with JSON {"reply": "...", "actions": [...]}. No tools, no code, no markdown outside the reply field. Keep reply under ${chat.config.maxReplyLength} chars.

User message: ${text}`;
    }

    // Send to session
    await this.sessions.send(chat.sessionId, wrappedMessage);

    // Get the last assistant message (the response we just generated)
    const session = this.sessions.get(chat.sessionId);
    if (!session) return;

    const lastMsg = session.messages[session.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      await transport.send(identity.transportUserId, "[no response]");
      return;
    }

    // Parse structured response
    const response = parseChatResponse(lastMsg.content);

    // Execute any actions
    if (response.actions && response.actions.length > 0) {
      const context: ActionContext = {
        identityId: identity.id,
        trustLevel: identity.trustLevel,
        sessionId: chat.sessionId,
      };

      for (const action of response.actions) {
        const result = this.actions.execute(action, context);
        log("router", "action executed", {
          action: action.action,
          ok: result.ok,
          message: result.message,
        });
      }
    }

    // Send reply back through transport
    await transport.send(identity.transportUserId, response.reply);
  }

  private findOrCreateChat(identity: TransportIdentity, transportName: string): ActiveChat {
    const existing = this.chats.get(identity.id);
    if (existing) {
      const session = this.sessions.get(existing.sessionId);
      if (session && session.state === "active") {
        return existing;
      }
      // Session died — clean up and recreate
      this.closeChat(existing);
    }
    return this.createChat(identity, transportName);
  }

  private createChat(identity: TransportIdentity, transportName: string, existingConfig?: SessionConfig): ActiveChat {
    const config = existingConfig ? { ...existingConfig } : { ...DEFAULT_SESSION_CONFIG };

    // Create a chat session
    const session = this.sessions.create("chat");

    // Build the system prompt (will be sent with the first user message)
    const availableActions = this.actions.forTrust(identity.trustLevel);
    const systemPrompt = buildChatSystemPrompt(identity, availableActions, config);

    const chat: ActiveChat = {
      systemPrompt,
      firstMessage: true,
      sessionId: session.id,
      identity,
      config,
      transport: transportName,
      lastMessageAt: Date.now(),
      idleTimer: null,
    };

    this.chats.set(identity.id, chat);
    log("router", "chat created", {
      identity: identity.id,
      sessionId: session.id,
      mode: config.mode,
      trustLevel: identity.trustLevel,
    });

    return chat;
  }

  private resetIdleTimer(chat: ActiveChat): void {
    if (chat.idleTimer) {
      clearTimeout(chat.idleTimer);
    }
    chat.lastMessageAt = Date.now();
    chat.idleTimer = setTimeout(() => {
      log("router", "idle timeout", { identity: chat.identity.id, sessionId: chat.sessionId });
      this.closeChat(chat);
      this.chats.delete(chat.identity.id);
    }, chat.config.idleTimeoutMs);
  }

  private closeChat(chat: ActiveChat): void {
    if (chat.idleTimer) {
      clearTimeout(chat.idleTimer);
      chat.idleTimer = null;
    }
    this.sessions.close(chat.sessionId);
  }

  /** Get an active chat by identity ID (for action handlers) */
  getChat(identityId: string): ActiveChat | undefined {
    return this.chats.get(identityId);
  }

  private registerBuiltinActions(): void {
    // set_timeout — change idle timeout for current session
    this.actions.register({
      name: "set_timeout",
      description: "Set the idle timeout for this chat session. After this many milliseconds of inactivity, the session closes and a new one starts on the next message.",
      minTrust: 1.0,
      schema: {
        value: "timeout in milliseconds (e.g. 14400000 for 4 hours)",
      },
      handler: (action, context) => {
        const value = Number(action.value);
        if (!value || value < 60000) {
          return { ok: false, message: "Timeout must be at least 60 seconds" };
        }
        const chat = this.getChat(context.identityId);
        if (!chat) return { ok: false, message: "No active chat" };
        chat.config.idleTimeoutMs = value;
        this.resetIdleTimer(chat);
        log("router", "timeout updated", { identity: context.identityId, timeoutMs: value });
        return { ok: true, message: `Timeout set to ${Math.round(value / 60000)} minutes` };
      },
    });

    // set_reply_length — change max reply character count
    this.actions.register({
      name: "set_reply_length",
      description: "Set the maximum character count for replies in this session.",
      minTrust: 0.5,
      schema: {
        value: "max characters (e.g. 200 for short replies, 1000 for detailed ones)",
      },
      handler: (action, context) => {
        const value = Number(action.value);
        if (!value || value < 50) {
          return { ok: false, message: "Reply length must be at least 50 characters" };
        }
        const chat = this.getChat(context.identityId);
        if (!chat) return { ok: false, message: "No active chat" };
        chat.config.maxReplyLength = value;
        log("router", "reply length updated", { identity: context.identityId, maxChars: value });
        return { ok: true, message: `Reply length set to ${value} chars` };
      },
    });

    // set_mode — switch to a named mode (starts new session)
    this.actions.register({
      name: "set_mode",
      description: "Switch to a different mode. This closes the current session and starts a new one with the mode's prompt overlay. Available modes can be listed with 'what modes are available?'",
      minTrust: 0.5,
      schema: {
        name: "mode name (e.g. 'chat', 'root', or any custom mode)",
      },
      handler: (action, context) => {
        const name = String(action.name || "").trim().toLowerCase();
        if (!name) return { ok: false, message: "Mode name required" };

        const available = listModes();
        if (!available.includes(name)) {
          return { ok: false, message: `Unknown mode '${name}'. Available: ${available.join(", ")}` };
        }

        const chat = this.getChat(context.identityId);
        if (!chat) return { ok: false, message: "No active chat" };

        // Update mode — the session will be recreated on next message
        // because we're about to close this one
        chat.config.mode = name;
        this.closeChat(chat);
        this.chats.delete(context.identityId);

        // Pre-create the new chat with the updated config
        const identity = chat.identity;
        const newChat = this.createChat(identity, chat.transport, chat.config);
        this.chats.set(identity.id, newChat);
        this.resetIdleTimer(newChat);

        log("router", "mode changed", { identity: context.identityId, mode: name });
        return { ok: true, message: `Switched to ${name} mode` };
      },
    });

    // create_mode — create a new named mode (root only)
    this.actions.register({
      name: "create_mode",
      description: "Create a new chat mode with a custom prompt. You (Claude) should generate the prompt text based on the user's description of what the mode should do. The prompt will be injected as a mode overlay in future sessions.",
      minTrust: 1.0,
      schema: {
        name: "mode name (lowercase, alphanumeric + hyphens)",
        prompt: "the full prompt text for this mode",
      },
      handler: (action) => {
        const name = String(action.name || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
        const prompt = String(action.prompt || "").trim();
        if (!name) return { ok: false, message: "Mode name required" };
        if (!prompt) return { ok: false, message: "Mode prompt required" };
        if (name === "chat" || name === "root") {
          return { ok: false, message: "Cannot overwrite built-in modes" };
        }

        saveMode(name, prompt);
        return { ok: true, message: `Mode '${name}' created` };
      },
    });
  }
}
