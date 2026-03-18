import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { bus, type DashboardEvent, type DashboardCommand } from "./events.js";
import { localTimestamp } from "../log.js";
import type { TrustSnapshot } from "../trust/types.js";
import type { UsageSnapshot } from "../usage/types.js";

const PORT = parseInt(process.env["DASHBOARD_PORT"] || "9100", 10);

export interface StateSnapshot {
  sessions: { id: string; type: string; messages: { role: string; content: string }[] }[];
  pipeline: string;
  pipelineError: string | null;
  trust: TrustSnapshot;
  usage: UsageSnapshot;
}

export function startDashboard(getSnapshot?: () => StateSnapshot): void {
  const htmlPath = path.join(import.meta.dirname, "../dashboard-ui/index.html");

  const logsDir = path.join(process.cwd(), "logs");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // GET /api/logs — list available log files
    if (url.pathname === "/api/logs" && req.method === "GET") {
      try {
        const files = fs.readdirSync(logsDir)
          .filter((f: string) => f.endsWith(".log"))
          .map((f: string) => {
            const stat = fs.statSync(path.join(logsDir, f));
            return { name: f, size: stat.size, mtime: stat.mtimeMs };
          })
          .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(files));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    // GET /api/logs/:name?tail=N — tail a specific log file
    const logMatch = url.pathname.match(/^\/api\/logs\/([a-zA-Z0-9._-]+)$/);
    if (logMatch && req.method === "GET") {
      const filename = logMatch[1];
      // Prevent path traversal
      if (filename.includes("..") || filename.includes("/")) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const filePath = path.join(logsDir, filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const tailLines = parseInt(url.searchParams.get("tail") || "200", 10);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter((l: string) => l.length > 0);
        const tail = lines.slice(-tailLines);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: filename, lines: tail, total: lines.length }));
      } catch {
        res.writeHead(500);
        res.end("Read error");
      }
      return;
    }

    // GET /api/pentest/results — list pentest result files
    const pentestResultsDir = path.resolve(process.env["HOME"] || "~", "projects/pentest/results");
    if (url.pathname === "/api/pentest/results" && req.method === "GET") {
      try {
        if (!fs.existsSync(pentestResultsDir)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("[]");
          return;
        }
        const files = fs.readdirSync(pentestResultsDir)
          .filter((f: string) => f.endsWith(".json"))
          .map((f: string) => {
            const stat = fs.statSync(path.join(pentestResultsDir, f));
            // Parse probe name and date from filename
            const match = f.match(/^([a-z]+)-(.+)\.json$/);
            return {
              name: f,
              probe: match ? match[1] : f,
              date: match ? match[2].replace(/_/, " ") : "",
              size: stat.size,
              mtime: stat.mtimeMs,
            };
          })
          .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(files));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    // GET /api/pentest/results/:name — read a specific result file
    const pentestMatch = url.pathname.match(/^\/api\/pentest\/results\/([a-zA-Z0-9._-]+\.json)$/);
    if (pentestMatch && req.method === "GET") {
      const filename = pentestMatch[1];
      if (filename.includes("..") || filename.includes("/")) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const filePath = path.join(pentestResultsDir, filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(content);
      } catch {
        res.writeHead(500);
        res.end("Read error");
      }
      return;
    }

    // GET /api/claude-usage — current usage snapshot
    if (url.pathname === "/api/claude-usage" && req.method === "GET") {
      const snapshot = getSnapshot?.();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot?.usage ?? { data: null, error: "no snapshot", lastFetch: null, nextFetch: null }));
      return;
    }

    // Default: serve dashboard HTML
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
    // Send recent history to new clients (skip session events — state_sync covers those)
    for (const event of recentEvents) {
      if (event.kind.startsWith("session_")) continue;
      ws.send(JSON.stringify(event));
    }

    // Send current state snapshot so client can rebuild sessions
    if (getSnapshot) {
      ws.send(JSON.stringify({
        kind: "state_sync",
        containerId: "_sessions",
        timestamp: localTimestamp(),
        data: getSnapshot(),
      }));
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
      ts: localTimestamp(),
      component: "dashboard",
      msg: "dashboard listening",
      data: { port: PORT, url: `http://localhost:${PORT}` },
    }));
  });
}
