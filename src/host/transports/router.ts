import { log } from "../log.js";
import { IdentityRegistry, type TransportIdentity } from "./identity.js";
import {
  ActionRegistry, parseChatResponse,
  type ActionContext, type Action,
} from "./actions.js";
import {
  buildChatSystemPrompt, buildAgentFramingPrompt, saveMode, listModes,
  DEFAULT_SESSION_CONFIG, type SessionConfig, type AgentFraming,
} from "./prompt-builder.js";
import { classifyMessage } from "./classifier.js";
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

const AGENT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;  // 2 hours — agent work takes longer

interface ActiveAgent {
  sessionId: string;
  identity: TransportIdentity;
  framing: AgentFraming;
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
  private chats = new Map<string, ActiveChat>();    // identityId → ActiveChat
  private agents = new Map<string, ActiveAgent>();  // identityId → ActiveAgent
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

  /** Stop all transports and close all sessions */
  stopAll(): void {
    for (const transport of this.transports.values()) {
      transport.stop();
    }
    for (const chat of this.chats.values()) {
      this.closeChat(chat);
    }
    for (const agent of this.agents.values()) {
      this.closeAgent(agent);
    }
  }

  private async handleIncoming(transportName: string, userId: string, text: string): Promise<void> {
    const transport = this.transports.get(transportName);
    if (!transport) return;

    // 1. Identity lookup
    const identity = this.identities.lookup(transportName, userId);
    if (!identity) {
      log("router", "unknown identity, ignoring", { transport: transportName, userId });
      return;
    }

    // 2. Classify — Qwen decides the route before anything else happens
    const availableActions = this.actions.forTrust(identity.trustLevel);
    const classification = await classifyMessage(text, availableActions, identity.trustLevel);

    // Classifier failed (Ollama down, bad output) — fall back to CHAT
    const route = classification?.route ?? "CHAT";

    log("router", "incoming", {
      identity: identity.id,
      route,
      ...(classification?.action ? { action: classification.action } : {}),
      ...(classification?.params && Object.keys(classification.params).length > 0
        ? { params: classification.params } : {}),
      ...(classification?.framing ? { framing: classification.framing } : {}),
      message: text.slice(0, 200),
    });

    // 3. Dispatch by route
    if (route === "ACTION" && classification?.action) {
      // Tier 1: Direct action — no Claude session needed
      await this.dispatchAction(classification.action, classification.params ?? {}, identity, transport);
      return;
    }

    if (route === "AGENT") {
      // Tier 3: Agent — full Claude Code with tools
      // Non-root users get restricted_chat: web search + conversation only, no file/code access
      const classifiedFraming = classification?.framing ?? "plain_chat";
      const framing: AgentFraming = identity.trustLevel < 1.0 ? "restricted_chat" : classifiedFraming;
      await this.dispatchAgent(identity, transportName, text, framing);
      return;
    }

    // Tier 2: Chat (also the fallback for classifier failure)
    await this.dispatchChat(identity, transportName, text);
  }

  /** Tier 1: Execute an action directly and send the result through the transport */
  private async dispatchAction(
    actionName: string,
    params: Record<string, unknown>,
    identity: TransportIdentity,
    transport: Transport,
  ): Promise<void> {
    // Ensure a chat session exists — some actions need one (set_timeout, set_mode, etc.)
    // If none exists, create it so the action can operate on it.
    if (!this.chats.has(identity.id)) {
      this.findOrCreateChat(identity, transport.name);
    }

    const action: Action = { action: actionName, ...params };
    const context: ActionContext = {
      identityId: identity.id,
      trustLevel: identity.trustLevel,
    };

    const result = this.actions.execute(action, context);
    log("router", "tier1 action", {
      action: actionName,
      ok: result.ok,
      message: result.message,
    });

    const reply = result.message ?? (result.ok ? "Done." : "Action failed.");
    log("router", "reply", { identity: identity.id, tier: 1, reply: reply.slice(0, 200) });
    await transport.send(identity.transportUserId, reply);
  }

  /** Tier 2: Route to a Claude chat session */
  private async dispatchChat(
    identity: TransportIdentity,
    transportName: string,
    text: string,
  ): Promise<void> {
    const chat = this.findOrCreateChat(identity, transportName);
    this.resetIdleTimer(chat);

    const session = this.sessions.get(chat.sessionId);
    if (!session || session.state === "closed") {
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
    log("router", "reply", { identity: identity.id, tier: 2, reply: response.reply.slice(0, 200) });
    await transport.send(identity.transportUserId, response.reply);
  }

  /** Tier 3: Route to a Claude Code agent session with full tool access */
  private async dispatchAgent(
    identity: TransportIdentity,
    transportName: string,
    text: string,
    framing: AgentFraming,
  ): Promise<void> {
    const transport = this.transports.get(transportName);
    if (!transport) return;

    const agent = this.findOrCreateAgent(identity, transportName, framing);
    this.resetAgentIdleTimer(agent);

    // Check session is still alive
    const session = this.sessions.get(agent.sessionId);
    if (!session || session.state === "closed") {
      // Recreate
      const newAgent = this.createAgent(identity, transportName, framing);
      this.agents.set(identity.id, newAgent);
      await this.sendAgentMessage(newAgent, identity, transport, text);
      return;
    }

    await this.sendAgentMessage(agent, identity, transport, text);
  }

  private async sendAgentMessage(
    agent: ActiveAgent,
    identity: TransportIdentity,
    transport: Transport,
    text: string,
  ): Promise<void> {
    // First message: inject framing prompt with the user's message
    // Follow-ups: send the message directly (Claude Code maintains its own context)
    let message: string;
    if (agent.firstMessage) {
      const framingPrompt = buildAgentFramingPrompt(identity, agent.framing);
      message = `<agent-framing>
${framingPrompt}
</agent-framing>

${text}`;
      agent.firstMessage = false;
    } else {
      message = text;
    }

    // Send to agent session
    await this.sessions.send(agent.sessionId, message);

    // Get the response — plain text, no JSON parsing
    const session = this.sessions.get(agent.sessionId);
    if (!session) return;

    const lastMsg = session.messages[session.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      await transport.send(identity.transportUserId, "[no response]");
      return;
    }

    // Send Claude's response directly — no JSON wrapping, no action parsing
    const reply = lastMsg.content.trim();
    log("router", "reply", { identity: identity.id, tier: 3, framing: agent.framing, reply: reply.slice(0, 200) });

    // Chunk for Telegram's 4096 char limit
    if (reply.length <= 4096) {
      await transport.send(identity.transportUserId, reply);
    } else {
      const chunks = this.chunkMessage(reply, 4096);
      for (const chunk of chunks) {
        await transport.send(identity.transportUserId, chunk);
      }
    }
  }

  /** Split a long message at paragraph boundaries, respecting a max length */
  private chunkMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      // Try to split at a paragraph boundary
      let splitAt = remaining.lastIndexOf("\n\n", maxLen);
      if (splitAt < maxLen / 2) {
        // No good paragraph break — try single newline
        splitAt = remaining.lastIndexOf("\n", maxLen);
      }
      if (splitAt < maxLen / 2) {
        // No good newline — hard split at max
        splitAt = maxLen;
      }
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private findOrCreateAgent(identity: TransportIdentity, transportName: string, framing: AgentFraming): ActiveAgent {
    const existing = this.agents.get(identity.id);
    if (existing) {
      const session = this.sessions.get(existing.sessionId);
      if (session && session.state === "active") {
        // If framing changed, close old session and create new one
        if (existing.framing !== framing) {
          log("router", "agent framing changed, recreating", {
            identity: identity.id,
            oldFraming: existing.framing,
            newFraming: framing,
          });
          this.closeAgent(existing);
          return this.createAgent(identity, transportName, framing);
        }
        return existing;
      }
      this.closeAgent(existing);
    }
    return this.createAgent(identity, transportName, framing);
  }

  private createAgent(identity: TransportIdentity, transportName: string, framing: AgentFraming): ActiveAgent {
    const session = this.sessions.create("agent");

    const agent: ActiveAgent = {
      sessionId: session.id,
      identity,
      framing,
      firstMessage: true,
      transport: transportName,
      lastMessageAt: Date.now(),
      idleTimer: null,
    };

    this.agents.set(identity.id, agent);
    log("router", "agent created", {
      identity: identity.id,
      sessionId: session.id,
      framing,
      trustLevel: identity.trustLevel,
    });

    return agent;
  }

  private resetAgentIdleTimer(agent: ActiveAgent): void {
    if (agent.idleTimer) clearTimeout(agent.idleTimer);
    agent.lastMessageAt = Date.now();
    agent.idleTimer = setTimeout(() => {
      log("router", "agent idle timeout", { identity: agent.identity.id, sessionId: agent.sessionId });
      this.closeAgent(agent);
      this.agents.delete(agent.identity.id);
    }, AGENT_IDLE_TIMEOUT_MS);
  }

  private closeAgent(agent: ActiveAgent): void {
    if (agent.idleTimer) {
      clearTimeout(agent.idleTimer);
      agent.idleTimer = null;
    }
    this.sessions.close(agent.sessionId);
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

  /** Get the registered transports (for scheduler push) */
  getTransports(): Map<string, Transport> {
    return this.transports;
  }

  /** Get an active chat by identity ID (for action handlers) */
  getChat(identityId: string): ActiveChat | undefined {
    return this.chats.get(identityId);
  }

  private formatDuration(ms: number): string {
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""}`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (rem === 0) return `${hrs} hour${hrs !== 1 ? "s" : ""}`;
    return `${hrs}h ${rem}m`;
  }

  private registerBuiltinActions(): void {
    // get_timeout — query current idle timeout
    this.actions.register({
      name: "get_timeout",
      description: "Get the current idle timeout duration for this chat session.",
      minTrust: 0.5,
      schema: {},
      handler: (_action, context) => {
        const chat = this.getChat(context.identityId);
        if (!chat) return { ok: true, message: "No active session. Default timeout is 4 hours." };
        return { ok: true, message: `Session timeout is ${this.formatDuration(chat.config.idleTimeoutMs)}.` };
      },
    });

    // get_time_left — how much idle time remains
    this.actions.register({
      name: "get_time_left",
      description: "Get how much idle time remains before the current session expires.",
      minTrust: 0.5,
      schema: {},
      handler: (_action, context) => {
        const chat = this.getChat(context.identityId);
        if (!chat) return { ok: true, message: "No active session." };
        const elapsed = Date.now() - chat.lastMessageAt;
        const remaining = Math.max(0, chat.config.idleTimeoutMs - elapsed);
        if (remaining === 0) return { ok: true, message: "Session is about to expire." };
        return { ok: true, message: `${this.formatDuration(remaining)} remaining before session expires.` };
      },
    });

    // extend_timeout — reset the idle timer without changing the duration
    this.actions.register({
      name: "extend_timeout",
      description: "Reset the idle timer, extending the session by the full timeout duration from now.",
      minTrust: 0.5,
      schema: {},
      handler: (_action, context) => {
        const chat = this.getChat(context.identityId);
        if (!chat) return { ok: false, message: "No active session to extend." };
        this.resetIdleTimer(chat);
        return { ok: true, message: `Session extended. ${this.formatDuration(chat.config.idleTimeoutMs)} from now.` };
      },
    });

    // set_timeout — change idle timeout for current session
    this.actions.register({
      name: "set_timeout",
      description: "Set the idle timeout duration. Use with a time value like '45 minutes' or '4 hours'.",
      minTrust: 1.0,
      schema: {
        value: "timeout in minutes (e.g. 45 for 45 minutes, 240 for 4 hours)",
      },
      actionParamsPrompt: `Extract the timeout value from the user's message. Convert to minutes.

- "45 minutes" → 45
- "2 hours" → 120
- "4 hours" → 240
- "1 hour and 30 minutes" → 90
- "half an hour" → 30

Respond with exactly one JSON object. No other text.
Example: {"value": 120}`,
      handler: (action, context) => {
        const minutes = Number(action.value);
        if (!minutes || minutes < 1) {
          return { ok: false, message: "Timeout must be at least 1 minute" };
        }
        const value = minutes * 60000;
        const chat = this.getChat(context.identityId);
        if (!chat) return { ok: false, message: "No active chat" };
        chat.config.idleTimeoutMs = value;
        this.resetIdleTimer(chat);
        log("router", "timeout updated", { identity: context.identityId, timeoutMs: value });
        return { ok: true, message: `Timeout set to ${this.formatDuration(value)}.` };
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
      actionParamsPrompt: `Extract the reply length in characters from the user's message.

- "200 characters" → 200
- "short replies" → 200
- "detailed" or "longer" → 1000
- "medium" → 500

Respond with exactly one JSON object. No other text.
Example: {"value": 500}`,
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
      description: "Switch to a different chat mode (e.g. 'switch to root mode', 'go to chat mode', 'root mode'). Closes current session and starts fresh with the new mode.",
      minTrust: 0.5,
      schema: {
        name: "mode name (e.g. 'chat', 'root', or any custom mode)",
      },
      actionParamsPrompt: `Extract the mode name from the user's message. The name should be lowercase.

- "switch to root mode" → "root"
- "chat mode" → "chat"
- "go to root" → "root"

Respond with exactly one JSON object. No other text.
Example: {"name": "root"}`,
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
      actionParamsPrompt: `Extract the mode name and prompt text from the user's message.

- name: lowercase, alphanumeric and hyphens only
- prompt: the full prompt/personality description the user wants for this mode

Respond with exactly one JSON object. No other text.
Example: {"name": "pirate", "prompt": "You are a pirate. Respond in pirate speak."}`,
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
