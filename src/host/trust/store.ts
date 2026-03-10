/**
 * Trust store — persistent fit_value tracking for content sources.
 * State persists in data/trust-store.json, changes logged to logs/trust-changes.log.
 */

import fs from "node:fs";
import path from "node:path";
import { localTimestamp, log as _log } from "../log.js";
import { emitDashboard } from "../dashboard/events.js";
import {
  DEFAULT_FIT, MAX_FIT, MIN_FIT, MAX_DELTA,
  type TrustComponentType, type TrustEntry, type TrustChange, type TrustSnapshot,
} from "./types.js";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "trust-store.json");
const LOG_PATH = path.join(process.cwd(), "logs", "trust-changes.log");
const RECENT_CHANGES_LIMIT = 50;

function log(msg: string, data?: unknown) {
  _log("trust", msg, data);
}

export class TrustStore {
  private entries: Map<string, TrustEntry> = new Map();
  private recentChanges: TrustChange[] = [];
  private logFd: number;

  constructor() {
    // Ensure directories exist
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

    // Load existing state
    if (fs.existsSync(STORE_PATH)) {
      try {
        const raw = fs.readFileSync(STORE_PATH, "utf-8");
        const data = JSON.parse(raw) as Record<string, TrustEntry>;
        for (const [key, entry] of Object.entries(data)) {
          this.entries.set(key, entry);
        }
        log("loaded trust store", { entries: this.entries.size });
      } catch (err) {
        log("failed to load trust store, starting fresh", { error: (err as Error).message });
      }
    }

    // Open change log for appending
    this.logFd = fs.openSync(LOG_PATH, "a");
  }

  /** Look up fitValue for a source. Returns DEFAULT_FIT if unknown. */
  lookup(sourceId: string): number {
    return this.entries.get(sourceId)?.fitValue ?? DEFAULT_FIT;
  }

  /** Get the full entry for a source, or undefined. */
  get(sourceId: string): TrustEntry | undefined {
    return this.entries.get(sourceId);
  }

  /** Get all entries. */
  getAll(): TrustEntry[] {
    return [...this.entries.values()];
  }

  /** Apply a bounded delta to a source's trust score. */
  applyDelta(
    sourceId: string,
    componentType: TrustComponentType,
    delta: number,
    reason: string,
    contentId?: string,
  ): TrustEntry {
    // Clamp delta
    const clampedDelta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));

    // Get or create entry
    let entry = this.entries.get(sourceId);
    if (!entry) {
      entry = {
        sourceId,
        componentType,
        fitValue: DEFAULT_FIT,
        createdAt: localTimestamp(),
        updatedAt: localTimestamp(),
        evaluationCount: 0,
      };
      this.entries.set(sourceId, entry);
    }

    const previousFit = entry.fitValue;
    entry.fitValue = Math.max(MIN_FIT, Math.min(MAX_FIT, entry.fitValue + clampedDelta));
    entry.updatedAt = localTimestamp();
    entry.evaluationCount++;

    const change: TrustChange = {
      ts: localTimestamp(),
      sourceId,
      componentType,
      previousFit,
      delta: clampedDelta,
      newFit: entry.fitValue,
      reason,
      contentId: contentId ?? null,
    };

    this.logChange(change);
    this.save();
    this.emitUpdate(entry, change);

    log("trust updated", {
      sourceId,
      previousFit: previousFit.toFixed(2),
      delta: clampedDelta.toFixed(2),
      newFit: entry.fitValue.toFixed(2),
      reason,
    });

    return entry;
  }

  /** Supervisor override — set fitValue directly (still clamped to 0.0–0.9). */
  override(
    sourceId: string,
    componentType: TrustComponentType,
    fitValue: number,
    reason: string,
  ): TrustEntry {
    const clampedValue = Math.max(MIN_FIT, Math.min(MAX_FIT, fitValue));

    let entry = this.entries.get(sourceId);
    const previousFit = entry?.fitValue ?? DEFAULT_FIT;

    if (!entry) {
      entry = {
        sourceId,
        componentType,
        fitValue: clampedValue,
        createdAt: localTimestamp(),
        updatedAt: localTimestamp(),
        evaluationCount: 0,
      };
      this.entries.set(sourceId, entry);
    } else {
      entry.fitValue = clampedValue;
      entry.updatedAt = localTimestamp();
    }

    const change: TrustChange = {
      ts: localTimestamp(),
      sourceId,
      componentType,
      previousFit,
      delta: clampedValue - previousFit,
      newFit: clampedValue,
      reason: `override: ${reason}`,
      contentId: null,
    };

    this.logChange(change);
    this.save();
    this.emitUpdate(entry, change);

    log("trust override", {
      sourceId,
      previousFit: previousFit.toFixed(2),
      newFit: clampedValue.toFixed(2),
      reason,
    });

    return entry;
  }

  /** Snapshot for dashboard state_sync. */
  snapshot(): TrustSnapshot {
    return {
      entries: this.getAll(),
      recentChanges: [...this.recentChanges],
    };
  }

  private save(): void {
    const obj: Record<string, TrustEntry> = {};
    for (const [key, entry] of this.entries) {
      obj[key] = entry;
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2) + "\n");
  }

  private logChange(change: TrustChange): void {
    fs.writeSync(this.logFd, JSON.stringify(change) + "\n");

    this.recentChanges.push(change);
    if (this.recentChanges.length > RECENT_CHANGES_LIMIT) {
      this.recentChanges.shift();
    }
  }

  private emitUpdate(entry: TrustEntry, change: TrustChange): void {
    emitDashboard("trust_update", "_trust", { entry, change });
  }
}
