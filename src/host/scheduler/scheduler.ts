import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { ActionRegistry, type ActionContext, type Action } from "../transports/actions.js";
import type { Transport } from "../transports/transport.js";

// ---------------------------------------------------------------------------
// Schedule definition — what's on disk and what's in memory
// ---------------------------------------------------------------------------

export interface ScheduleDefinition {
  /** Action name to execute (must be registered in ActionRegistry) */
  action: string;
  /** Static params to pass to the action */
  params?: Record<string, unknown>;
  /** Schedule type */
  type: "interval" | "cron";
  /** For interval: milliseconds between runs */
  intervalMs?: number;
  /** For cron: cron-like spec (see parseCron) */
  cron?: string;
  /** Identity to execute as (for trust gating). Defaults to root. */
  identityId?: string;
  /** Trust level for execution. Defaults to 1.0 (root). */
  trustLevel?: number;
  /** Push config: where to send results proactively */
  push?: PushConfig;
  /** Cache duration in ms. Results are cached and served to Tier 1 queries. */
  cacheDurationMs?: number;
  /** Whether the schedule is enabled. Defaults to true. */
  enabled?: boolean;
}

export interface PushConfig {
  /** Transport name to push through (e.g. "telegram") */
  transport: string;
  /** User ID on that transport */
  userId: string;
  /** Push condition: "always", "on_change", or a simple expression (future) */
  condition: "always" | "on_change" | "never";
}

interface ActiveSchedule {
  definition: ScheduleDefinition;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null;
  lastResult?: CachedResult;
  nextRunAt?: Date;
}

export interface CachedResult {
  action: string;
  ok: boolean;
  message?: string;
  timestamp: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Cron parsing — lightweight, Pacific time, covers our use cases
// ---------------------------------------------------------------------------

interface CronSpec {
  minute: number;
  hour: number;
  daysOfWeek?: number[];  // 0=Sunday, 1=Monday, ..., 6=Saturday. undefined = every day
}

/**
 * Parse a simple cron string into a CronSpec.
 * Supported formats:
 *   "6:30"          → daily at 6:30am Pacific
 *   "06:30"         → daily at 6:30am Pacific
 *   "18:00"         → daily at 6:00pm Pacific
 *   "weekdays 6:30" → Mon-Fri at 6:30am Pacific
 *   "weekend 9:00"  → Sat-Sun at 9:00am Pacific
 *   "mon,wed,fri 8:00" → specific days
 */
function parseCron(spec: string): CronSpec | null {
  const parts = spec.trim().toLowerCase().split(/\s+/);

  let timeStr: string;
  let daysOfWeek: number[] | undefined;

  if (parts.length === 1) {
    // Just a time — daily
    timeStr = parts[0];
  } else if (parts.length === 2) {
    const daySpec = parts[0];
    timeStr = parts[1];

    if (daySpec === "weekdays" || daySpec === "weekday") {
      daysOfWeek = [1, 2, 3, 4, 5];
    } else if (daySpec === "weekend" || daySpec === "weekends") {
      daysOfWeek = [0, 6];
    } else {
      // Parse comma-separated day names
      const dayMap: Record<string, number> = {
        sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
      };
      const days = daySpec.split(",").map(d => dayMap[d.trim()]);
      if (days.some(d => d === undefined)) return null;
      daysOfWeek = days as number[];
    }
  } else {
    return null;
  }

  // Parse time
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) return null;

  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute, daysOfWeek };
}

/**
 * Calculate ms until the next occurrence of a cron spec in Pacific time.
 */
function msUntilNext(spec: CronSpec): number {
  const now = new Date();
  // Get current time in Pacific
  const pacificNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));

  // Start with today's target time
  const target = new Date(pacificNow);
  target.setHours(spec.hour, spec.minute, 0, 0);

  // If target is in the past today, start from tomorrow
  if (target <= pacificNow) {
    target.setDate(target.getDate() + 1);
  }

  // If days-of-week is specified, advance to the next matching day
  if (spec.daysOfWeek) {
    let safety = 0;
    while (!spec.daysOfWeek.includes(target.getDay()) && safety < 8) {
      target.setDate(target.getDate() + 1);
      safety++;
    }
  }

  // Convert back: figure out the actual wall-clock difference
  // We need to compute the target in real UTC terms
  const targetPacificStr = target.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const targetPacific = new Date(targetPacificStr);

  // The difference in "Pacific minutes" is what we want
  const diffMs = target.getTime() - pacificNow.getTime();
  return Math.max(diffMs, 1000);  // at least 1 second
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const SCHEDULES_DIR = path.join(process.cwd(), ".local", "config", "schedules");

export class Scheduler {
  private actions: ActionRegistry;
  private transports: Map<string, Transport>;
  private schedules = new Map<string, ActiveSchedule>();  // action name → active schedule
  private cache = new Map<string, CachedResult>();        // action name → cached result

  constructor(actions: ActionRegistry, transports: Map<string, Transport>) {
    this.actions = actions;
    this.transports = transports;
  }

  /** Load schedule definitions from disk and start all enabled schedules */
  start(): void {
    const definitions = this.loadFromDisk();
    log("scheduler", "loaded definitions", { count: definitions.length });

    for (const def of definitions) {
      if (def.enabled === false) {
        log("scheduler", "skipping disabled schedule", { action: def.action });
        continue;
      }
      this.addSchedule(def);
    }
  }

  /** Stop all scheduled timers */
  stop(): void {
    for (const [name, schedule] of this.schedules) {
      if (schedule.timer) {
        clearTimeout(schedule.timer as ReturnType<typeof setTimeout>);
        clearInterval(schedule.timer as ReturnType<typeof setInterval>);
        schedule.timer = null;
      }
      log("scheduler", "stopped", { action: name });
    }
    this.schedules.clear();
  }

  /** Add a schedule and start its timer */
  addSchedule(def: ScheduleDefinition): void {
    // Stop existing schedule for this action if any
    const existing = this.schedules.get(def.action);
    if (existing?.timer) {
      clearTimeout(existing.timer as ReturnType<typeof setTimeout>);
      clearInterval(existing.timer as ReturnType<typeof setInterval>);
    }

    const schedule: ActiveSchedule = {
      definition: def,
      timer: null,
    };

    if (def.type === "interval" && def.intervalMs) {
      schedule.timer = setInterval(() => {
        this.executeScheduled(def);
      }, def.intervalMs);
      schedule.nextRunAt = new Date(Date.now() + def.intervalMs);
      log("scheduler", "interval started", {
        action: def.action,
        intervalMs: def.intervalMs,
        nextRun: schedule.nextRunAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
      });
    } else if (def.type === "cron" && def.cron) {
      const spec = parseCron(def.cron);
      if (!spec) {
        log("scheduler", "invalid cron spec", { action: def.action, cron: def.cron });
        return;
      }
      // Schedule the first run, then reschedule after each run
      this.scheduleCronRun(def, spec, schedule);
    } else {
      log("scheduler", "invalid schedule definition", { action: def.action, type: def.type });
      return;
    }

    this.schedules.set(def.action, schedule);
  }

  /** Remove a schedule and stop its timer */
  removeSchedule(actionName: string): void {
    const schedule = this.schedules.get(actionName);
    if (schedule?.timer) {
      clearTimeout(schedule.timer as ReturnType<typeof setTimeout>);
      clearInterval(schedule.timer as ReturnType<typeof setInterval>);
    }
    this.schedules.delete(actionName);
    log("scheduler", "removed", { action: actionName });
  }

  /** Get a cached result for an action (for Tier 1 to serve instantly) */
  getCached(actionName: string): CachedResult | undefined {
    const cached = this.cache.get(actionName);
    if (!cached) return undefined;
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(actionName);
      return undefined;
    }
    return cached;
  }

  /** Get a snapshot of all schedules for dashboard/status */
  snapshot(): { action: string; type: string; enabled: boolean; nextRun?: string; lastResult?: CachedResult }[] {
    return [...this.schedules.entries()].map(([name, s]) => ({
      action: name,
      type: s.definition.type,
      enabled: s.definition.enabled !== false,
      nextRun: s.nextRunAt?.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
      lastResult: s.lastResult,
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private scheduleCronRun(def: ScheduleDefinition, spec: CronSpec, schedule: ActiveSchedule): void {
    const delayMs = msUntilNext(spec);
    schedule.nextRunAt = new Date(Date.now() + delayMs);

    log("scheduler", "cron scheduled", {
      action: def.action,
      cron: def.cron,
      nextRun: schedule.nextRunAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
      delayMs,
    });

    schedule.timer = setTimeout(() => {
      this.executeScheduled(def);
      // Reschedule for next occurrence
      this.scheduleCronRun(def, spec, schedule);
    }, delayMs);
  }

  private async executeScheduled(def: ScheduleDefinition): Promise<void> {
    const action: Action = { action: def.action, ...(def.params ?? {}) };
    const context: ActionContext = {
      identityId: def.identityId ?? "scheduler",
      trustLevel: def.trustLevel ?? 1.0,
    };

    log("scheduler", "executing", { action: def.action, params: def.params });

    const result = this.actions.execute(action, context);
    const schedule = this.schedules.get(def.action);

    const cached: CachedResult = {
      action: def.action,
      ok: result.ok,
      message: result.message,
      timestamp: Date.now(),
      expiresAt: Date.now() + (def.cacheDurationMs ?? 5 * 60 * 1000),  // default 5 min cache
    };

    // Cache the result
    this.cache.set(def.action, cached);
    if (schedule) schedule.lastResult = cached;

    log("scheduler", "executed", {
      action: def.action,
      ok: result.ok,
      message: result.message?.slice(0, 200),
    });

    // Push if configured
    if (def.push && def.push.condition !== "never") {
      await this.pushResult(def, cached);
    }
  }

  private async pushResult(def: ScheduleDefinition, result: CachedResult): Promise<void> {
    if (!def.push) return;

    const transport = this.transports.get(def.push.transport);
    if (!transport) {
      log("scheduler", "push transport not found", { transport: def.push.transport, action: def.action });
      return;
    }

    // Check push condition
    if (def.push.condition === "on_change") {
      const schedule = this.schedules.get(def.action);
      const prev = schedule?.lastResult;
      if (prev && prev.message === result.message) {
        log("scheduler", "push skipped (no change)", { action: def.action });
        return;
      }
    }

    const message = result.message ?? (result.ok ? `${def.action}: done` : `${def.action}: failed`);

    try {
      await transport.send(def.push.userId, message);
      log("scheduler", "pushed", { action: def.action, transport: def.push.transport, userId: def.push.userId });
    } catch (err) {
      log("scheduler", "push error", { action: def.action, error: (err as Error).message });
    }
  }

  private loadFromDisk(): ScheduleDefinition[] {
    if (!fs.existsSync(SCHEDULES_DIR)) {
      log("scheduler", "no schedules directory, creating", { path: SCHEDULES_DIR });
      fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
      return [];
    }

    const files = fs.readdirSync(SCHEDULES_DIR).filter(f => f.endsWith(".json"));
    const definitions: ScheduleDefinition[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(SCHEDULES_DIR, file), "utf-8");
        const def = JSON.parse(content) as ScheduleDefinition;
        definitions.push(def);
      } catch (err) {
        log("scheduler", "failed to load schedule", { file, error: (err as Error).message });
      }
    }

    return definitions;
  }

  /** Save a schedule definition to disk */
  saveSchedule(def: ScheduleDefinition): void {
    fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
    const filePath = path.join(SCHEDULES_DIR, `${def.action}.json`);
    fs.writeFileSync(filePath, JSON.stringify(def, null, 2), "utf-8");
    log("scheduler", "saved to disk", { action: def.action, path: filePath });
  }

  /** Delete a schedule definition from disk */
  deleteSchedule(actionName: string): void {
    const filePath = path.join(SCHEDULES_DIR, `${actionName}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log("scheduler", "deleted from disk", { action: actionName });
    }
  }
}
