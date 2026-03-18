import fs from "node:fs";
import path from "node:path";
import { log as _log, localTimestamp } from "../log.js";
import type { UsageSnapshot } from "./types.js";

// Minibot.app writes this file — we just read it
const CACHE_PATH = path.join(
  process.env["HOME"] || "~",
  ".minibot",
  "claude-usage.json",
);
const READ_INTERVAL_MS = 30 * 1000; // check file every 30s

function log(msg: string, data?: unknown) {
  _log("usage", msg, data);
}

/**
 * Reads usage data from the cache file written by Minibot.app's UsagePoller.
 * The Swift layer handles the actual HTTP calls to claude.ai (avoids Cloudflare).
 */
export class UsageService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: UsageSnapshot = {
    data: null,
    error: null,
    lastFetch: null,
    nextFetch: null,
  };

  /** Start reading the cache file periodically. */
  start(): void {
    if (this.timer) return;
    log("starting (reading from Minibot.app cache)", { path: CACHE_PATH });
    this.readCache(); // immediate first read
    this.timer = setInterval(() => this.readCache(), READ_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log("stopped");
    }
  }

  /** Get the latest snapshot. */
  getSnapshot(): UsageSnapshot {
    return this.snapshot;
  }

  /** Force a re-read of the cache file. */
  refresh(): UsageSnapshot {
    this.readCache();
    return this.snapshot;
  }

  private readCache(): void {
    try {
      if (!fs.existsSync(CACHE_PATH)) {
        this.snapshot = {
          data: null,
          error: "Cache file not found — is Minibot.app running?",
          lastFetch: null,
          nextFetch: null,
        };
        return;
      }

      const raw = fs.readFileSync(CACHE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as UsageSnapshot;
      this.snapshot = parsed;

      if (parsed.data) {
        log("cache read", {
          fiveHour: parsed.data.five_hour.utilization,
          sevenDay: parsed.data.seven_day.utilization,
          lastFetch: parsed.lastFetch,
        });
      }
    } catch (err) {
      this.snapshot.error = `cache read error: ${(err as Error).message}`;
      log("cache read error", { error: (err as Error).message });
    }
  }
}
