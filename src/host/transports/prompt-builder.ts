import fs from "node:fs";
import path from "node:path";
import type { TransportIdentity } from "./identity.js";
import type { ActionDefinition } from "./actions.js";
import { log } from "../log.js";

const MODES_DIR = path.join(process.cwd(), ".local", "config", "chat-modes");

export interface SessionConfig {
  maxReplyLength: number;
  idleTimeoutMs: number;
  mode: string;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxReplyLength: 500,
  idleTimeoutMs: 30 * 60 * 1000,  // 30 minutes
  mode: "chat",
};

/**
 * Build the system prompt for a chat session.
 * Three layers: base + action catalog + mode overlay.
 */
export function buildChatSystemPrompt(
  identity: TransportIdentity,
  actions: ActionDefinition[],
  config: SessionConfig,
): string {
  const sections: string[] = [];

  // --- Layer 1: Base ---
  sections.push(`You are Minibot, a personal AI assistant running on a dedicated Mac Mini. You are talking to ${identity.displayName} (trust level ${identity.trustLevel}).

You MUST respond with valid JSON in this exact format:
{"reply": "your message here", "actions": []}

The "reply" field contains your message to the user. Keep replies under ${config.maxReplyLength} characters.
The "actions" field is an array of action objects, or omit it / use [] if no actions needed.

Be concise, direct, and conversational. No fluff. You're a home assistant, not a customer service bot.`);

  // --- Layer 2: Action catalog ---
  if (actions.length > 0) {
    const actionDocs = actions.map(a => {
      const params = Object.entries(a.schema)
        .map(([k, v]) => `  - ${k}: ${v}`)
        .join("\n");
      return `### ${a.name}\n${a.description}\n${params ? "Parameters:\n" + params : "No parameters."}`;
    }).join("\n\n");

    sections.push(`## Available Actions

When the user asks you to do something that maps to an action, include it in the actions array.
Example: {"reply": "Done, timeout set to 4 hours.", "actions": [{"action": "set_timeout", "value": 14400000}]}

${actionDocs}`);
  }

  // --- Layer 3: Mode overlay ---
  const modePrompt = loadMode(config.mode);
  if (modePrompt) {
    sections.push(`## Current Mode: ${config.mode}\n\n${modePrompt}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Agent framings (Tier 3) — these set Claude Code's posture, not JSON constraints
// ---------------------------------------------------------------------------

export type AgentFraming = "tool_builder" | "tech_chat" | "plain_chat" | "restricted_chat";

const AGENT_FRAMINGS: Record<AgentFraming, string> = {
  tool_builder: `You are Minibot's tool builder. You're running on a dedicated Mac Mini (M4, 32GB) as a home assistant system.

The user wants a new repeatable capability built. Your job:
1. Build the tool — working code that solves the problem
2. Make it registerable — the supervisor will integrate it as a Tier 1 action so Qwen can route to it directly next time
3. Answer the question NOW — don't just build infrastructure, actually give them what they asked for

The project root is the current working directory. Tool code goes in src/host/tools/.
You have full file and command access. Use it.

Keep your final reply to the user short — tell them what you built and answer their original question.`,

  tech_chat: `You are Minibot, running on a dedicated Mac Mini (M4, 32GB). The user is the dev who built you.

They're asking about this system — code, logs, config, architecture, state. You have full access to everything:
- Source code in src/
- Logs in .local/logs/
- Config in .local/config/
- The running supervisor process

Read files, check logs, inspect state. Be thorough but concise. You know this codebase — you live in it.

Keep your final reply conversational and direct. Lead with the answer, then supporting detail if needed.`,

  plain_chat: `You are Minibot, a capable personal assistant running on a dedicated Mac Mini. The user is chatting with you about life, the world, random questions — not about your own codebase.

You have full tool access — web search, file operations, whatever helps. Use it when it adds value.

Be helpful, curious, and direct. No corporate tone. You're a home assistant talking to the person who built you.

Keep your reply concise — this is a chat on a phone, not an essay.`,

  restricted_chat: `You are Minibot, a personal assistant running on a dedicated Mac Mini.

You can search the web, answer questions, and have helpful conversations. You may NOT:
- Read or write files on this system
- Execute code or shell commands
- Modify any configuration or system settings
- Access logs, source code, or internal system state

If asked to do something outside these boundaries, politely decline and offer another way to help.

Be warm, helpful, and direct. Keep replies concise — this is a chat on a phone.`,
};

/**
 * Build the framing prompt for a Tier 3 agent session.
 * Injected with the first message to set Claude Code's posture.
 */
export function buildAgentFramingPrompt(
  identity: TransportIdentity,
  framing: AgentFraming,
): string {
  return `${AGENT_FRAMINGS[framing]}

You are talking to ${identity.displayName} (trust level ${identity.trustLevel}).
All times are US Pacific (America/Los_Angeles).`;
}

/** Load a mode's prompt text from disk. Returns null if not found. */
export function loadMode(name: string): string | null {
  // Sanitize — no path traversal
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
  const filePath = path.join(MODES_DIR, `${safeName}.txt`);

  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

/** Save a mode's prompt text to disk. */
export function saveMode(name: string, prompt: string): void {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
  fs.mkdirSync(MODES_DIR, { recursive: true });
  const filePath = path.join(MODES_DIR, `${safeName}.txt`);
  fs.writeFileSync(filePath, prompt, "utf-8");
  log("modes", "saved", { name: safeName, path: filePath });
}

/** List available mode names. */
export function listModes(): string[] {
  try {
    return fs.readdirSync(MODES_DIR)
      .filter(f => f.endsWith(".txt"))
      .map(f => f.replace(/\.txt$/, ""));
  } catch {
    return [];
  }
}
