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
