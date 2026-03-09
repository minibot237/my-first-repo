import { EventEmitter } from "node:events";

export interface DashboardEvent {
  kind: "container_start" | "container_stop" | "ops" | "work_in" | "work_out" | "error";
  containerId: string;
  timestamp: string;
  data: unknown;
}

export interface DashboardCommand {
  action: "nudge" | "stop";
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
