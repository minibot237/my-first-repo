import { EventEmitter } from "node:events";
import { localTimestamp } from "../log.js";

export interface DashboardEvent {
  kind: "container_start" | "container_stop" | "ops" | "work_in" | "work_out" | "error"
    | "session_created" | "session_message" | "session_chunk" | "session_closed" | "session_error"
    | "state_sync" | "pipeline_status"
    | "canary_result";
  containerId: string;
  timestamp: string;
  data: unknown;
}

export interface DashboardCommand {
  action: "nudge" | "stop" | "session_create" | "session_send" | "session_close" | "session_clear_all" | "pipeline_start" | "supervisor_restart" | "clear_logs" | "canary_evaluate";
  containerId: string;
  data?: unknown;
}

export const bus = new EventEmitter();

export function emitDashboard(kind: DashboardEvent["kind"], containerId: string, data: unknown) {
  bus.emit("dashboard", {
    kind,
    containerId,
    timestamp: localTimestamp(),
    data,
  } satisfies DashboardEvent);
}
