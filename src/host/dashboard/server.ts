import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { bus, type DashboardEvent, type DashboardCommand } from "./events.js";

const PORT = parseInt(process.env["DASHBOARD_PORT"] || "9100", 10);

export function startDashboard(): void {
  const htmlPath = path.join(import.meta.dirname, "../dashboard-ui/index.html");

  const server = http.createServer((_req, res) => {
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(500);
      res.end("Dashboard HTML not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
  });

  const wss = new WebSocketServer({ server });

  // Buffer recent events so new clients get context
  const recentEvents: DashboardEvent[] = [];
  const MAX_RECENT = 200;

  bus.on("dashboard", (event: DashboardEvent) => {
    recentEvents.push(event);
    if (recentEvents.length > MAX_RECENT) recentEvents.shift();

    const json = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  });

  wss.on("connection", (ws) => {
    // Send recent history to new clients (skip session events — they're ephemeral)
    for (const event of recentEvents) {
      if (event.kind.startsWith("session_")) continue;
      ws.send(JSON.stringify(event));
    }

    ws.on("message", (raw) => {
      try {
        const cmd = JSON.parse(raw.toString()) as DashboardCommand;
        bus.emit("command", cmd);
      } catch {
        // ignore bad messages
      }
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      component: "dashboard",
      msg: "dashboard listening",
      data: { port: PORT, url: `http://localhost:${PORT}` },
    }));
  });
}
