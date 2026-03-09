import { EventEmitter } from "node:events";

export interface DashboardEvent {
  kind: "container_start" | "container_stop" | "ops" | "work_in" | "work_out" | "error"
    | "session_created" | "session_message" | "session_chunk" | "session_closed" | "session_error"
    | "state_sync" | "pipeline_status";
  containerId: string;
  timestamp: string;
  data: unknown;
}

export interface DashboardCommand {
  action: "nudge" | "stop" | "session_create" | "session_send" | "session_close" | "pipeline_start";
  containerId: string;
  data?: unknown;
}

export const bus = new EventEmitter();

export function emitDashboard(kind: DashboardEvent["kind"], containerId: string, data: unknown) {
  bus.emit("dashboard", {
    kind,
    containerId,
    timestamp: new Date().toISOString(),
    data,
  } satisfies DashboardEvent);
}
