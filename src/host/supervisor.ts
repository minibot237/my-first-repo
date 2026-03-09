import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import {
  encode, makeHelloAck, makeNudge, makeWebFetchResponse,
  MessageReader, type Message,
} from "../shared/protocol.js";
import { AppleContainersRuntime } from "./runtime/apple-containers.js";
import { DockerRuntime } from "./runtime/docker.js";
import type { ContainerRuntime } from "./runtime/types.js";
import { startDashboard } from "./dashboard/server.js";
import { emitDashboard, bus, type DashboardCommand } from "./dashboard/events.js";
import { SessionManager, type SessionType } from "./sessions/manager.js";

const RUNTIME = process.env["RUNTIME"] || "apple-containers";
const SOCKET_PATH = process.env["SOCKET_PATH"] || path.join(process.cwd(), "minibot.sock");
const CONTAINER_SOCKET = "/tmp/minibot.sock";
const IMAGE_TAG = "minibot-agent";
const CONTEXT_DIR = path.join(process.cwd(), "container-image");

function log(msg: string, data?: unknown) {
  const entry = { ts: new Date().toISOString(), component: "supervisor", msg, ...(data !== undefined ? { data } : {}) };
  console.log(JSON.stringify(entry));
}

// --- Track active container sockets for sending commands ---
const containerSockets = new Map<string, net.Socket>();

function handleMessage(sock: net.Socket, msg: Message, containerId: string) {
  const eventKind = msg.channel === "ops" ? "ops" as const : "work_in" as const;
  emitDashboard(eventKind, containerId, { type: msg.type, id: msg.id, payload: msg.payload });

  switch (msg.type) {
    case "hello": {
      const ack = makeHelloAck(msg.id);
      log("hello from agent, sending ack", { containerId });
      sock.write(encode(ack));
      emitDashboard("work_out", containerId, { type: ack.type, id: ack.id, payload: ack.payload });
      break;
    }

    case "heartbeat":
      // Just logged to dashboard above, no response needed
      break;

    case "nudge_ack":
      log("agent acked nudge", { containerId });
      break;

    case "web_fetch": {
      // Contrived response for demo
      const url = (msg.payload as { url?: string })?.url || "unknown";
      log("agent requested web_fetch", { containerId, url });
      const body = `{"demo": true, "message": "Hello from supervisor proxy", "url": "${url}"}`;
      const resp = makeWebFetchResponse(msg.id, body);
      sock.write(encode(resp));
      emitDashboard("work_out", containerId, { type: resp.type, id: resp.id, payload: resp.payload });
      break;
    }

    default:
      log("unhandled message", { type: msg.type, channel: msg.channel });
  }
}

// --- Session manager ---
const sessionManager = new SessionManager();

// --- Handle dashboard commands ---
bus.on("command", (cmd: DashboardCommand) => {
  log("dashboard command", { action: cmd.action, containerId: cmd.containerId });

  if (cmd.action === "session_create") {
    const { type } = cmd.data as { type: SessionType };
    const session = sessionManager.create(type);
    log("session created", { sessionId: session.id, type });
    return;
  }

  if (cmd.action === "session_send") {
    const { sessionId, content } = cmd.data as { sessionId: string; content: string };
    log("session send", { sessionId, contentLength: content.length });
    sessionManager.send(sessionId, content).catch((err) => {
      log("session send error", { sessionId, error: (err as Error).message });
    });
    return;
  }

  if (cmd.action === "session_close") {
    const { sessionId } = cmd.data as { sessionId: string };
    sessionManager.close(sessionId);
    log("session closed", { sessionId });
    return;
  }

  if (cmd.action === "pipeline_start") {
    startContainers();
    return;
  }

  if (cmd.action === "nudge") {
    // Send nudge to all containers or a specific one
    const targets = cmd.containerId === "*"
      ? [...containerSockets.entries()]
      : [[cmd.containerId, containerSockets.get(cmd.containerId)] as const].filter(([, s]) => s);

    for (const [id, sock] of targets) {
      if (sock && !sock.destroyed) {
        const nudge = makeNudge();
        sock.write(encode(nudge));
        emitDashboard("ops", id as string, { type: "nudge_sent", id: nudge.id });
        log("nudge sent", { containerId: id });
      }
    }
  }
});

// --- Apple Containers: supervisor connects to agent ---

async function connectToAgent(socketPath: string, containerId: string, retries = 20, delayMs = 500): Promise<net.Socket> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await tryConnect(socketPath, containerId);
    } catch (err) {
      const message = (err as Error).message;
      const retryable = (err as NodeJS.ErrnoException).code === "ECONNREFUSED"
        || message === "disconnected before handshake";
      if (retryable && attempt < retries) {
        log("agent not ready, retrying", { attempt, maxRetries: retries });
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

function tryConnect(socketPath: string, containerId: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    log("connecting to agent", { path: socketPath });
    let resolved = false;

    const sock = net.createConnection(socketPath, () => {
      log("tcp connected, waiting for agent hello");
    });

    const reader = new MessageReader();

    sock.on("data", (chunk) => {
      const messages = reader.push(chunk);
      for (const msg of messages) {
        if (!resolved) {
          resolved = true;
          containerSockets.set(containerId, sock);
          resolve(sock);
        }
        handleMessage(sock, msg, containerId);
      }
    });

    sock.on("error", (err) => {
      containerSockets.delete(containerId);
      if (!resolved) {
        reject(err);
      } else {
        emitDashboard("error", containerId, { message: (err as Error).message });
      }
    });

    sock.on("close", () => {
      containerSockets.delete(containerId);
      if (!resolved) {
        reject(new Error("disconnected before handshake"));
      } else {
        log("disconnected from agent", { containerId });
      }
    });
  });
}

// --- Docker: supervisor listens, agent connects ---

function listenForAgent(socketPath: string, containerId: string, timeoutMs = 15000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for agent to connect"));
    }, timeoutMs);

    const server = net.createServer((sock) => {
      log("agent connected");
      clearTimeout(timeout);
      containerSockets.set(containerId, sock);

      const reader = new MessageReader();

      sock.on("data", (chunk) => {
        const messages = reader.push(chunk);
        for (const msg of messages) {
          handleMessage(sock, msg, containerId);
        }
      });

      sock.on("close", () => {
        containerSockets.delete(containerId);
        log("disconnected");
        server.close();
      });

      sock.on("error", (err) => {
        containerSockets.delete(containerId);
        emitDashboard("error", containerId, { message: err.message });
      });

      resolve(sock);
    });

    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

    server.listen(socketPath, () => {
      log("supervisor listening", { path: socketPath });
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function waitForSocket(socketPath: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for socket at ${socketPath}`);
}

function pickRuntime(name: string): ContainerRuntime {
  switch (name) {
    case "apple-containers": return new AppleContainersRuntime();
    case "docker": return new DockerRuntime();
    default: throw new Error(`Unknown runtime: ${name}`);
  }
}

// --- Container pipeline ---

type PipelineState = "idle" | "building" | "starting" | "running" | "error";
let pipelineState: PipelineState = "idle";
let pipelineError: string | null = null;
let activeHandle: { stop(): Promise<void> } | null = null;

function setPipeline(state: PipelineState, detail?: string) {
  pipelineState = state;
  pipelineError = state === "error" ? (detail ?? null) : null;
  emitDashboard("pipeline_status", "_supervisor", { state, detail });
  log("pipeline", { state, detail });
}

async function startContainers() {
  if (pipelineState === "building" || pipelineState === "starting") {
    log("pipeline already in progress, ignoring start request");
    return;
  }

  // Stop existing container if restarting
  if (activeHandle) {
    emitDashboard("container_stop", "core", { reason: "restart" });
    try { await activeHandle.stop(); } catch { /* may have exited */ }
    activeHandle = null;
  }

  const containerId = "core";

  try {
    const runtime = pickRuntime(RUNTIME);
    log("using runtime", { name: runtime.name });

    setPipeline("building");
    await runtime.buildImage(IMAGE_TAG, CONTEXT_DIR);

    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

    setPipeline("starting");

    if (RUNTIME === "docker") {
      const listenPromise = listenForAgent(SOCKET_PATH, containerId);

      const handle = await runtime.start(IMAGE_TAG, {
        rm: true,
        publishSocket: { hostPath: SOCKET_PATH, containerPath: CONTAINER_SOCKET },
        env: { SOCKET_PATH: CONTAINER_SOCKET, AGENT_MODE: "connect" },
      });
      activeHandle = handle;

      await listenPromise;
      emitDashboard("container_start", containerId, { runtime: "docker", imageTag: IMAGE_TAG });
    } else {
      const handle = await runtime.start(IMAGE_TAG, {
        publishSocket: { hostPath: SOCKET_PATH, containerPath: CONTAINER_SOCKET },
        env: { SOCKET_PATH: CONTAINER_SOCKET },
      });
      activeHandle = handle;

      emitDashboard("container_start", containerId, { runtime: "apple-containers", imageTag: IMAGE_TAG });
      await waitForSocket(SOCKET_PATH);
      await connectToAgent(SOCKET_PATH, containerId);
    }

    setPipeline("running");
  } catch (err) {
    setPipeline("error", (err as Error).message);
  }
}

// --- Main ---

async function main() {
  // Dashboard + sessions are always available, regardless of container state
  startDashboard(() => ({
    ...sessionManager.snapshot(),
    pipeline: pipelineState,
    pipelineError,
  }));

  log("supervisor ready — dashboard at http://localhost:9100");

  // Auto-start containers in background (non-blocking, non-fatal)
  startContainers();

  // Keep process alive, clean shutdown on SIGINT
  process.on("SIGINT", async () => {
    log("shutting down");
    if (activeHandle) {
      emitDashboard("container_stop", "core", { reason: "user" });
      try { await activeHandle.stop(); } catch { /* may have exited */ }
    }
    process.exit(0);
  });
}

main().catch((err) => {
  log("fatal", { error: err.message });
  process.exit(1);
});
