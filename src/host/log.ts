import fs from "node:fs";
import path from "node:path";

const LOGS_DIR = path.join(process.cwd(), "logs");

/** Local ISO-ish timestamp: 2026-03-09T19:48:03.424-07:00 */
export function localTimestamp(): string {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const sign = off <= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, "0");
  const mm = String(absOff % 60).padStart(2, "0");
  // Shift to local then format as ISO without the Z
  const local = new Date(now.getTime() - off * 60000);
  return local.toISOString().replace("Z", "") + sign + hh + ":" + mm;
}

/** Structured log to stdout with local timestamp */
export function log(component: string, msg: string, data?: unknown) {
  const entry = { ts: localTimestamp(), component, msg, ...(data !== undefined ? { data } : {}) };
  console.log(JSON.stringify(entry));
}

/** Per-session log file writer */
export class SessionLog {
  private fd: number;
  readonly filePath: string;

  constructor(agentType: string, sessionId: string) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const filename = `${agentType}-${sessionId}.log`;
    this.filePath = path.join(LOGS_DIR, filename);
    this.fd = fs.openSync(this.filePath, "a");
    this.write("session_start", { agentType, sessionId });
  }

  write(event: string, data?: unknown) {
    const entry = { ts: localTimestamp(), event, ...(data !== undefined ? { data } : {}) };
    fs.writeSync(this.fd, JSON.stringify(entry) + "\n");
  }

  user(content: string) {
    this.write("user", { content });
  }

  assistant(content: string) {
    this.write("assistant", { content });
  }

  chunk(delta: string) {
    this.write("chunk", { delta });
  }

  error(message: string) {
    this.write("error", { message });
  }

  close() {
    this.write("session_end");
    fs.closeSync(this.fd);
  }
}
