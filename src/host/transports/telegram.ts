import fs from "node:fs";
import { log } from "../log.js";
import type { Transport } from "./transport.js";

const TELEGRAM_API = "https://api.telegram.org/bot";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_S = 30;  // long-polling timeout
const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramConfig {
  /** Path to file containing the bot token */
  tokenPath: string;
  /** Allowed user IDs — messages from unknown users are silently dropped */
  allowedUserIds: Set<string>;
}

export class TelegramTransport implements Transport {
  readonly name = "telegram";
  onMessage: (userId: string, text: string) => void = () => {};

  private token: string = "";
  private baseUrl: string = "";
  private offset: number = 0;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private allowedUserIds: Set<string>;
  private tokenPath: string;
  private botUsername: string = "";

  constructor(config: TelegramConfig) {
    this.tokenPath = config.tokenPath;
    this.allowedUserIds = config.allowedUserIds;
  }

  async start(): Promise<void> {
    // Load token
    if (!fs.existsSync(this.tokenPath)) {
      log("telegram", "bot token not found, transport disabled", { path: this.tokenPath });
      return;
    }
    this.token = fs.readFileSync(this.tokenPath, "utf-8").trim();
    if (!this.token) {
      log("telegram", "bot token is empty, transport disabled");
      return;
    }
    this.baseUrl = `${TELEGRAM_API}${this.token}`;

    // Verify bot and get username
    try {
      const me = await this.apiCall("getMe");
      this.botUsername = me.username || "unknown";
      log("telegram", "transport active", {
        bot: `@${this.botUsername}`,
        allowedUsers: this.allowedUserIds.size,
      });
    } catch (err) {
      log("telegram", "failed to connect", { error: (err as Error).message });
      return;
    }

    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log("telegram", "transport stopped");
  }

  async send(userId: string, text: string): Promise<void> {
    // Chunk long messages at paragraph boundaries
    const chunks = chunkMessage(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.apiCall("sendMessage", {
        chat_id: userId,
        text: chunk,
        parse_mode: "Markdown",
      }).catch(async () => {
        // Markdown parse failed — retry without formatting
        await this.apiCall("sendMessage", {
          chat_id: userId,
          text: chunk,
        });
      });
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const updates = await this.apiCall("getUpdates", {
        offset: this.offset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: JSON.stringify(["message"]),
      });

      if (Array.isArray(updates)) {
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update);
        }
      }
    } catch (err) {
      log("telegram", "poll error", { error: (err as Error).message });
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
    }
  }

  private handleUpdate(update: any): void {
    const message = update.message;
    if (!message) return;

    const userId = String(message.from?.id || "");
    const text = message.text;

    // Ignore non-text messages
    if (!text || !userId) return;

    // Allowlist check
    if (!this.allowedUserIds.has(userId)) {
      log("telegram", "rejected message from unknown user", { userId });
      return;
    }

    // Handle /start (Telegram requires this)
    if (text === "/start") {
      this.send(userId, "Hey. Minibot here.").catch(() => {});
      return;
    }

    this.onMessage(userId, text);
  }

  private async apiCall(method: string, params?: Record<string, unknown>): Promise<any> {
    const url = `${this.baseUrl}/${method}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
    });

    const data = await response.json() as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description || "unknown"}`);
    }
    return data.result;
  }
}

/** Split text into chunks that fit within maxLen, preferring paragraph boundaries */
function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    // Fall back to single newline
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
    // Fall back to space
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", maxLen);
    // Hard split as last resort
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
