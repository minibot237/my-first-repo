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
import { evaluateContent } from "./canary/evaluate.js";
import { evaluatePipeline } from "./canary/pipeline.js";
import type { PipelineResult } from "./canary/pipeline.js";
import { ingestEmail } from "./ingest/email.js";
import { TrustStore } from "./trust/store.js";
import type { TrustComponentType, TrustList } from "./trust/types.js";
import { log as _log, localTimestamp } from "./log.js";
import { IdentityRegistry } from "./transports/identity.js";
import { ActionRegistry } from "./transports/actions.js";
import { TransportRouter } from "./transports/router.js";
import { TelegramTransport } from "./transports/telegram.js";
import { Scheduler } from "./scheduler/scheduler.js";

const RUNTIME = process.env["RUNTIME"] || "apple-containers";
const CANARY_LOG_PATH = path.join(process.cwd(), "logs", "canary-evaluations.log");
const CANARY_THREATS_PATH = path.join(process.cwd(), "logs", "canary-threats.log");
const SOCKET_PATH = process.env["SOCKET_PATH"] || path.join(process.cwd(), "minibot.sock");
const CONTAINER_SOCKET = "/tmp/minibot.sock";
const IMAGE_TAG = "minibot-agent";
const CONTEXT_DIR = path.join(process.cwd(), "container-image");

function log(msg: string, data?: unknown) {
  _log("supervisor", msg, data);
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

// --- Trust store ---
const trustStore = new TrustStore();

// --- Transport layer ---
const TELEGRAM_TOKEN_PATH = path.join(process.cwd(), ".local", "secrets", "telegram-bot-token");

const identityRegistry = new IdentityRegistry();
identityRegistry.loadFromDisk();

const actionRegistry = new ActionRegistry();
const transportRouter = new TransportRouter(identityRegistry, actionRegistry, sessionManager);

const telegramTransport = new TelegramTransport({
  tokenPath: TELEGRAM_TOKEN_PATH,
  allowedUserIds: identityRegistry.userIdsForTransport("telegram"),
});
transportRouter.addTransport(telegramTransport);

// --- Scheduler ---
const scheduler = new Scheduler(actionRegistry, transportRouter.getTransports());

// --- Scheduler actions (Tier 1) ---
actionRegistry.register({
  name: "list_schedules",
  description: "List all scheduled tasks and their next run times.",
  minTrust: 0.5,
  schema: {},
  handler: () => {
    const schedules = scheduler.snapshot();
    if (schedules.length === 0) {
      return { ok: true, message: "No scheduled tasks." };
    }
    const lines = schedules.map(s => {
      const status = s.enabled ? "✓" : "✗";
      const next = s.nextRun ? ` → next: ${s.nextRun}` : "";
      const last = s.lastResult?.message ? ` (last: ${s.lastResult.message.slice(0, 60)})` : "";
      return `${status} ${s.action} [${s.type}]${next}${last}`;
    });
    return { ok: true, message: lines.join("\n") };
  },
});

actionRegistry.register({
  name: "add_schedule",
  description: "Add a new scheduled task. Runs a registered action on a timer. Example: 'schedule get_timeout every 30 minutes' or 'schedule get_time_left daily at 9:00'.",
  minTrust: 1.0,
  schema: {
    action: "action name to schedule",
    type: "'interval' or 'cron'",
    interval: "for interval: minutes between runs (e.g. 30)",
    cron: "for cron: time spec (e.g. '9:00', 'weekdays 8:30')",
    push: "'always', 'on_change', or 'never' (default: always)",
  },
  actionParamsPrompt: `Extract schedule parameters from the user's message.

- action: the name of the action to schedule
- type: "interval" if they say "every X minutes/hours", "cron" if they say "at X:XX" or "daily at"
- interval: number of minutes between runs (only for interval type)
- cron: time spec like "9:00" or "weekdays 8:30" (only for cron type)
- push: "always" unless they say otherwise

Examples:
"schedule get_timeout every 30 minutes" → {"action":"get_timeout","type":"interval","interval":30,"push":"always"}
"run get_time_left daily at 9am" → {"action":"get_time_left","type":"cron","cron":"9:00","push":"always"}
"check disk every hour, only tell me if it changes" → {"action":"check_disk","type":"interval","interval":60,"push":"on_change"}

Respond with exactly one JSON object. No other text.`,
  handler: (params) => {
    const actionName = String(params.action || "").trim();
    if (!actionName) return { ok: false, message: "Action name required." };

    const type = String(params.type || "").trim() as "interval" | "cron";
    if (type !== "interval" && type !== "cron") {
      return { ok: false, message: "Schedule type must be 'interval' or 'cron'." };
    }

    const def: any = {
      action: actionName,
      type,
      enabled: true,
      trustLevel: 1.0,
      push: {
        transport: "telegram",
        userId: [...identityRegistry.userIdsForTransport("telegram")][0] || "",
        condition: String(params.push || "always").trim() as any,
      },
    };

    if (type === "interval") {
      const minutes = Number(params.interval);
      if (!minutes || minutes < 1) return { ok: false, message: "Interval must be at least 1 minute." };
      def.intervalMs = minutes * 60000;
    } else {
      const cron = String(params.cron || "").trim();
      if (!cron) return { ok: false, message: "Cron time spec required (e.g. '9:00', 'weekdays 8:30')." };
      def.cron = cron;
    }

    scheduler.saveSchedule(def);
    scheduler.addSchedule(def);
    return { ok: true, message: `Scheduled ${actionName} (${type}${type === "interval" ? `, every ${Number(params.interval)}m` : `, ${def.cron}`}).` };
  },
});

actionRegistry.register({
  name: "remove_schedule",
  description: "Remove a scheduled task by action name.",
  minTrust: 1.0,
  schema: {
    action: "action name to unschedule",
  },
  actionParamsPrompt: `Extract the action name to remove from the schedule.

Respond with exactly one JSON object. No other text.
Example: {"action": "get_timeout"}`,
  handler: (params) => {
    const actionName = String(params.action || "").trim();
    if (!actionName) return { ok: false, message: "Action name required." };
    scheduler.removeSchedule(actionName);
    scheduler.deleteSchedule(actionName);
    return { ok: true, message: `Removed schedule for ${actionName}.` };
  },
});

// --- Handle dashboard commands ---
bus.on("command", async (cmd: DashboardCommand) => {
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

  if (cmd.action === "session_clear_all") {
    const count = sessionManager.list().length;
    sessionManager.closeAll();
    log("all sessions cleared", { count });
    return;
  }

  if (cmd.action === "clear_logs") {
    const logsDir = path.join(process.cwd(), "logs");
    if (fs.existsSync(logsDir)) {
      for (const f of fs.readdirSync(logsDir)) {
        if (f.endsWith(".log")) {
          try { fs.unlinkSync(path.join(logsDir, f)); } catch {}
        }
      }
    }
    log("logs cleared");
    return;
  }

  if (cmd.action === "canary_evaluate") {
    const { content } = cmd.data as { content: string };
    log("canary evaluate requested", { contentLength: content.length });

    // Show scan request in canary vm-panel work channel
    emitDashboard("work_in", "canary", { type: "scan", payload: { content } });

    evaluateContent(content).then((result) => {
      // Show verdict in canary vm-panel work channel
      emitDashboard("work_out", "canary", {
        type: "verdict",
        payload: {
          safe: result.safe,
          fitScore: result.fitScore,
          observationScore: result.observationScore,
          source: result.source,
          regexHits: result.regexHits.map(h => h.pattern),
          flags: result.llmVerdict?.flags || [],
        },
      });
      // Console output
      emitDashboard("canary_result", "canary", result);

      // Append to canary evaluation log (full content, every evaluation)
      const logEntry = {
        ts: localTimestamp(),
        content,
        safe: result.safe,
        source: result.source,
        fitScore: result.fitScore,
        observationScore: result.observationScore,
        regexHits: result.regexHits.map(h => h.pattern),
        flags: result.llmVerdict?.flags || [],
        reasoning: result.llmVerdict?.reasoning || null,
        durationMs: result.durationMs,
      };
      fs.mkdirSync(path.dirname(CANARY_LOG_PATH), { recursive: true });
      fs.appendFileSync(CANARY_LOG_PATH, JSON.stringify(logEntry) + "\n");

      // Duplicate flagged content to threats log for processing
      if (!result.safe) {
        fs.appendFileSync(CANARY_THREATS_PATH, JSON.stringify(logEntry) + "\n");
      }
    }).catch((err) => {
      emitDashboard("work_out", "canary", {
        type: "error",
        payload: { error: (err as Error).message },
      });
      emitDashboard("canary_result", "canary", {
        safe: false,
        source: "error",
        regexHits: [],
        llmVerdict: null,
        rawLlmResponse: null,
        durationMs: 0,
        fitScore: 0.0,
        observationScore: 0.0,
        error: (err as Error).message,
      });

      // Log errors to both files (errors are threats — something blocked evaluation)
      const errorEntry = {
        ts: localTimestamp(),
        content,
        safe: false,
        source: "error",
        error: (err as Error).message,
      };
      fs.mkdirSync(path.dirname(CANARY_LOG_PATH), { recursive: true });
      fs.appendFileSync(CANARY_LOG_PATH, JSON.stringify(errorEntry) + "\n");
      fs.appendFileSync(CANARY_THREATS_PATH, JSON.stringify(errorEntry) + "\n");
    });
    return;
  }

  if (cmd.action === "trust_query") {
    emitDashboard("trust_update", "_trust", trustStore.snapshot());
    return;
  }

  if (cmd.action === "trust_override") {
    const { sourceId, componentType, fitValue, reason } = cmd.data as {
      sourceId: string; componentType: TrustComponentType; fitValue: number; reason: string;
    };
    trustStore.override(sourceId, componentType, fitValue, reason);
    return;
  }

  if (cmd.action === "trust_list") {
    const { sourceId, componentType, list, reason } = cmd.data as {
      sourceId: string; componentType: TrustComponentType; list: TrustList | null; reason: string;
    };
    trustStore.setList(sourceId, componentType, list, reason);
    return;
  }

  if (cmd.action === "email_ingest") {
    const { path: emlPath } = cmd.data as { path: string };
    log("email ingest requested", { path: emlPath });
    emitDashboard("ingest_start", "canary", { path: emlPath });

    processEmail(emlPath).catch((err) => {
      log("email ingest error", { path: emlPath, error: (err as Error).message });
      emitDashboard("ingest_result", "canary", {
        path: emlPath,
        error: (err as Error).message,
      });
    });
    return;
  }

  if (cmd.action === "batch_ingest") {
    const { dir, limit } = cmd.data as { dir: string; limit?: number };
    log("batch ingest requested", { dir, limit });
    batchIngest(dir, limit).catch((err) => {
      log("batch ingest error", { dir, error: (err as Error).message });
    });
    return;
  }

  if (cmd.action === "pipeline_start") {
    startContainers();
    return;
  }

  if (cmd.action === "supervisor_restart") {
    log("restart requested from dashboard");
    // Clean shutdown — launchd will restart us
    if (activeHandle) {
      try { await activeHandle.stop(); } catch { /* may have exited */ }
    }
    sessionManager.closeAll();
    process.exit(0);
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

// --- Email processing: ingest → pipeline → trust update ---

async function processEmail(emlPath: string): Promise<PipelineResult> {
  // Step 1: Ingest with trust lookup
  const envelope = await ingestEmail(emlPath, (sourceId) => trustStore.lookup(sourceId));

  log("email ingested", {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    sourceFit: envelope.sourceFit,
    subject: (envelope.content as { envelope?: { subject?: string } }).envelope?.subject?.slice(0, 60),
  });

  // Step 2: Run full canary pipeline (pass trust list for prompt routing)
  const trustEntry = trustStore.get(envelope.sourceId);
  const result = await evaluatePipeline(envelope, trustEntry?.list);

  // Step 3: Seed trust for new sources
  trustStore.seedIfNew(
    envelope.sourceId,
    "email_sender",
    result.initialFit,
    result.initialFitReason,
  );

  // Step 4: Apply trust delta from code tools
  if (result.sourceFitDelta !== 0) {
    trustStore.applyDelta(
      envelope.sourceId,
      "email_sender",
      result.sourceFitDelta,
      `code-tools: ${result.codeSignals.length} signals`,
      envelope.id,
    );
  }

  // Step 5: Apply trust delta from LLM verdict
  if (result.evaluation.llmVerdict) {
    const llmDelta = result.safe ? 0.05 : -0.10;
    trustStore.applyDelta(
      envelope.sourceId,
      "email_sender",
      llmDelta,
      result.safe ? "canary: safe" : `canary: flagged (${result.evaluation.llmVerdict.flags?.join(", ") || "unknown"})`,
      envelope.id,
    );
  }

  // Step 6: Log and emit
  const logEntry = {
    ts: localTimestamp(),
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    path: emlPath,
    safe: result.safe,
    preFilterTier: result.preFilterTier,
    fitScore: result.evaluation.fitScore,
    observationScore: result.evaluation.observationScore,
    sourceFitDelta: result.sourceFitDelta,
    initialFit: result.initialFit,
    trustAfter: trustStore.lookup(envelope.sourceId),
    flags: result.evaluation.llmVerdict?.flags || [],
    durationMs: result.durationMs,
  };
  fs.mkdirSync(path.dirname(CANARY_LOG_PATH), { recursive: true });
  fs.appendFileSync(CANARY_LOG_PATH, JSON.stringify(logEntry) + "\n");

  if (!result.safe) {
    fs.appendFileSync(CANARY_THREATS_PATH, JSON.stringify(logEntry) + "\n");
  }

  emitDashboard("ingest_result", "canary", logEntry);

  log("email processed", {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    safe: result.safe,
    tier: result.preFilterTier,
    fitScore: result.evaluation.fitScore,
    trustAfter: trustStore.lookup(envelope.sourceId),
    durationMs: result.durationMs,
  });

  return result;
}

async function batchIngest(dir: string, limit?: number): Promise<void> {
  const resolvedDir = dir.replace("~", process.env["HOME"]!);
  const files = fs.readdirSync(resolvedDir)
    .filter(f => f.endsWith(".eml"))
    .sort();

  const batch = limit ? files.slice(0, limit) : files;
  log("batch ingest starting", { dir: resolvedDir, total: files.length, processing: batch.length });

  let processed = 0;
  let safe = 0;
  let flagged = 0;
  let errors = 0;

  for (const file of batch) {
    const emlPath = path.join(resolvedDir, file);
    try {
      const result = await processEmail(emlPath);
      processed++;
      if (result.safe) safe++;
      else flagged++;
    } catch (err) {
      errors++;
      log("batch ingest: file error", { file, error: (err as Error).message });
    }
  }

  log("batch ingest complete", { dir: resolvedDir, processed, safe, flagged, errors, total: batch.length });
}

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
    trust: trustStore.snapshot(),
    schedules: scheduler.snapshot(),
  }));

  log("supervisor ready — dashboard at http://localhost:9100");

  // Start transport layer (non-blocking, non-fatal)
  transportRouter.startAll().catch(err => {
    log("transport startup error", { error: (err as Error).message });
  });

  // Start scheduler (loads definitions from .local/config/schedules/)
  scheduler.start();

  // Auto-start containers in background (non-blocking, non-fatal)
  startContainers();

  // Keep process alive, clean shutdown on SIGINT
  process.on("SIGINT", async () => {
    log("shutting down");
    scheduler.stop();
    transportRouter.stopAll();
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
