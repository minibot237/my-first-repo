/**
 * CORE model evaluation: benchmark Ollama models for routing, summarization, planning.
 *
 * Usage:
 *   node dist/host/eval/model-eval.js                          # run all Tier 1 models
 *   EVAL_MODELS=qwen2.5:7b,gemma3:4b node dist/host/eval/model-eval.js   # specific models
 *   LOG_QUIET=1 node dist/host/eval/model-eval.js              # suppress per-call logs
 *
 * Appends to logs/model-eval.log with a header per run.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { localTimestamp } from "../log.js";

// ── Config ───────────────────────────────────────────────────────────

const ENDPOINT = "http://localhost:11434/v1/chat/completions";

const DEFAULT_MODELS = [
  // Tier 1 — speed-first (3-4B)
  "llama3.2:3b",
  "gemma3:4b",
  "phi4-mini",
  // Tier 2 — balanced (7-8B)
  "qwen2.5:7b",
  "mistral:7b",
  "llama3.1:8b",
  // Tier 3 — quality-first (9-14B)
  "gemma3:12b",
];

const MODELS = process.env.EVAL_MODELS
  ? process.env.EVAL_MODELS.split(",").map(m => m.trim())
  : DEFAULT_MODELS;

const LOG_FILE = resolve(process.cwd(), "logs", "model-eval.log");
mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });

// ── System prompt — draft CORE role ──────────────────────────────────

const CORE_SYSTEM = `You are CORE, a routing and decision engine for a home assistant system. You receive structured data packages containing canary verdicts, code signals, and trust metadata — never raw content.

Your responses must be concise and structured. When asked for JSON, respond with valid JSON only — no markdown fences, no commentary.`;

// ── Test tasks ───────────────────────────────────────────────────────

interface Task {
  id: string;
  name: string;
  userMessage: string;
  expectJson: boolean;
  validate: (output: string) => { ok: boolean; note: string };
}

function validateJson(output: string, requiredFields: string[]): { ok: boolean; note: string } {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, note: "no JSON found" };
  try {
    const parsed = JSON.parse(match[0]);
    const missing = requiredFields.filter(f => !(f in parsed));
    if (missing.length > 0) return { ok: false, note: `missing: ${missing.join(", ")}` };
    return { ok: true, note: "" };
  } catch {
    return { ok: false, note: "invalid JSON" };
  }
}

const TASKS: Task[] = [
  {
    id: "A1",
    name: "summarize-short",
    userMessage: `Summarize this evaluation package in 2-3 sentences:

{
  "source": "email",
  "sourceId": "newsletter@techdigest.io",
  "sourceFit": 0.72,
  "canaryVerdict": { "safe": true, "confidence": 0.88, "flags": [] },
  "codeSignals": [
    { "tool": "evaluate-envelope", "severity": "low", "signal": "missing-date-header" },
    { "tool": "evaluate-links", "severity": "low", "signal": "url-shortener", "detail": "bit.ly link in body" }
  ],
  "subject": "Weekly Tech Roundup #412"
}`,
    expectJson: false,
    validate: (out) => {
      const len = out.trim().length;
      if (len < 20) return { ok: false, note: "too short" };
      if (len > 800) return { ok: false, note: "too long" };
      return { ok: true, note: "" };
    },
  },
  {
    id: "A2",
    name: "summarize-batch",
    userMessage: `Summarize these 3 evaluations. List them in priority order (most important first) with a one-line summary each:

[
  {
    "source": "email", "sourceId": "alerts@bank-secure.com", "sourceFit": 0.15,
    "canaryVerdict": { "safe": false, "confidence": 0.92, "flags": ["urgency-manipulation", "credential-request"] },
    "codeSignals": [
      { "tool": "evaluate-envelope", "severity": "high", "signal": "spf-fail" },
      { "tool": "evaluate-links", "severity": "critical", "signal": "display-href-mismatch" }
    ],
    "subject": "URGENT: Verify your account immediately"
  },
  {
    "source": "email", "sourceId": "team@projectboard.dev", "sourceFit": 0.65,
    "canaryVerdict": { "safe": true, "confidence": 0.85, "flags": [] },
    "codeSignals": [],
    "subject": "Sprint review notes — March 10"
  },
  {
    "source": "web", "sourceId": "https://docs.example.com/api/v2", "sourceFit": 0.70,
    "canaryVerdict": { "safe": true, "confidence": 0.91, "flags": [] },
    "codeSignals": [
      { "tool": "evaluate-web", "severity": "low", "signal": "script-detected", "detail": "analytics.js" }
    ],
    "subject": "API v2 Documentation"
  }
]`,
    expectJson: false,
    validate: (out) => {
      const len = out.trim().length;
      if (len < 50) return { ok: false, note: "too short" };
      if (len > 1500) return { ok: false, note: "too long" };
      return { ok: true, note: "" };
    },
  },
  {
    id: "B1",
    name: "route-clear",
    userMessage: `Route this content. Respond with JSON: { "action": "archive"|"review"|"alert"|"block", "reason": "..." }

{
  "source": "email", "sourceId": "deals@shopblast.com", "sourceFit": 0.68,
  "canaryVerdict": { "safe": true, "confidence": 0.95, "flags": [] },
  "codeSignals": [],
  "subject": "50% off everything this weekend!"
}`,
    expectJson: true,
    validate: (out) => validateJson(out, ["action", "reason"]),
  },
  {
    id: "B2",
    name: "route-ambiguous",
    userMessage: `Route this content. Respond with JSON: { "action": "archive"|"review"|"alert"|"block", "reason": "..." }

{
  "source": "email", "sourceId": "noreply@service-update.net", "sourceFit": 0.31,
  "canaryVerdict": { "safe": true, "confidence": 0.62, "flags": [] },
  "codeSignals": [
    { "tool": "evaluate-envelope", "severity": "medium", "signal": "dkim-missing" },
    { "tool": "evaluate-links", "severity": "medium", "signal": "url-shortener", "detail": "t.co link to unknown domain" }
  ],
  "subject": "Action required: update your preferences"
}`,
    expectJson: true,
    validate: (out) => validateJson(out, ["action", "reason"]),
  },
  {
    id: "C1",
    name: "plan-prioritize",
    userMessage: `You have 3 pending items. Pick the action order and justify each. Respond with JSON: { "order": [{ "sourceId": "...", "action": "...", "reason": "..." }] }

Items:
1. sourceId: "team@projectboard.dev", sourceFit: 0.65, verdict: safe, subject: "Sprint review notes — March 10"
2. sourceId: "alerts@bank-secure.com", sourceFit: 0.15, verdict: unsafe (flags: urgency-manipulation, credential-request), subject: "URGENT: Verify your account"
3. sourceId: "docs.example.com/api/v2", sourceFit: 0.70, verdict: safe, subject: "API v2 Documentation"`,
    expectJson: true,
    validate: (out) => {
      const v = validateJson(out, ["order"]);
      if (!v.ok) return v;
      const match = out.match(/\{[\s\S]*\}/);
      try {
        const parsed = JSON.parse(match![0]);
        if (!Array.isArray(parsed.order) || parsed.order.length < 3) {
          return { ok: false, note: "order array too short" };
        }
      } catch { /* already checked */ }
      return { ok: true, note: "" };
    },
  },
];

// ── Ollama call with streaming ───────────────────────────────────────

interface CallResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  totalMs: number;
}

async function callOllama(model: string, systemPrompt: string, userMessage: string): Promise<CallResult> {
  const callStart = Date.now();

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let ttftMs = 0;
  let firstToken = true;
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          if (firstToken) {
            ttftMs = Date.now() - callStart;
            firstToken = false;
          }
          output += delta;
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  return {
    content: output,
    promptTokens,
    completionTokens,
    ttftMs,
    totalMs: Date.now() - callStart,
  };
}

// ── Output helpers ───────────────────────────────────────────────────

function out(line: string) {
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function logJson(obj: Record<string, unknown>) {
  appendFileSync(LOG_FILE, JSON.stringify(obj) + "\n");
}

// ── Main ─────────────────────────────────────────────────────────────

interface ModelResult {
  model: string;
  tasks: {
    id: string;
    name: string;
    ttftMs: number;
    totalMs: number;
    tokPerSec: number;
    promptTokens: number;
    completionTokens: number;
    structOk: boolean;
    note: string;
    output: string;
  }[];
  avgMs: number;
  avgTtft: number;
  avgTokPerSec: number;
  structOkCount: number;
}

async function warmUp(model: string): Promise<number> {
  const start = Date.now();
  await callOllama(model, "You are a test.", "Say hello in one word.");
  return Date.now() - start;
}

async function runModel(model: string): Promise<ModelResult> {
  out(`\n--- ${model} ---`);

  // Warm up (loads model into memory)
  const warmMs = await warmUp(model);
  out(`  warming up... (${warmMs}ms)`);

  const tasks: ModelResult["tasks"] = [];

  for (const task of TASKS) {
    const result = await callOllama(model, CORE_SYSTEM, task.userMessage);
    const tokPerSec = result.completionTokens > 0 && result.totalMs > result.ttftMs
      ? result.completionTokens / ((result.totalMs - result.ttftMs) / 1000)
      : 0;

    const validation = task.validate(result.content);

    const taskResult = {
      id: task.id,
      name: task.name,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      tokPerSec,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      structOk: validation.ok,
      note: validation.note,
      output: result.content,
    };
    tasks.push(taskResult);

    const structLabel = task.expectJson
      ? (validation.ok ? "✓json" : `✗json(${validation.note})`)
      : (validation.ok ? "✓" : `✗(${validation.note})`);

    out(
      `  ${task.id} ${task.name.padEnd(20)} ` +
      `${String(result.totalMs).padStart(5)}ms  ` +
      `ttft:${String(result.ttftMs).padStart(4)}ms  ` +
      `${tokPerSec.toFixed(1).padStart(6)} t/s  ` +
      `${structLabel}  ` +
      `tokens:${result.promptTokens}→${result.completionTokens}`
    );

    // Show the actual model output
    out(`  ┌─ output ─────────────────────────────────────────────────`);
    for (const line of result.content.split("\n")) {
      out(`  │ ${line}`);
    }
    out(`  └─────────────────────────────────────────────────────────`);
    out("");

    // Full result to log file
    logJson({
      model,
      task: task.id,
      name: task.name,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      tokPerSec: Math.round(tokPerSec * 10) / 10,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      structOk: validation.ok,
      note: validation.note,
      grade: null,
      output: result.content,
    });
  }

  const avgMs = tasks.reduce((s, t) => s + t.totalMs, 0) / tasks.length;
  const avgTtft = tasks.reduce((s, t) => s + t.ttftMs, 0) / tasks.length;
  const avgTokPerSec = tasks.reduce((s, t) => s + t.tokPerSec, 0) / tasks.length;
  const structOkCount = tasks.filter(t => t.structOk).length;

  out(
    `  avg: ${avgMs.toFixed(0)}ms  ttft:${avgTtft.toFixed(0)}ms  ` +
    `${avgTokPerSec.toFixed(1)} t/s  struct:${structOkCount}/${tasks.length}`
  );

  return { model, tasks, avgMs, avgTtft, avgTokPerSec, structOkCount };
}

async function main() {
  const ts = localTimestamp();

  out("");
  out(`╔══════════════════════════════════════════════════════════════╗`);
  out(`║  MODEL EVAL  ${ts.padEnd(46)}║`);
  out(`║  models: ${MODELS.join(", ").padEnd(50)}║`);
  out(`║  tasks: ${TASKS.length} (${TASKS.map(t => t.id).join(", ")})`.padEnd(63) + `║`);
  out(`╚══════════════════════════════════════════════════════════════╝`);

  const results: ModelResult[] = [];

  for (const model of MODELS) {
    try {
      const result = await runModel(model);
      results.push(result);
    } catch (err) {
      out(`\n--- ${model} ---`);
      out(`  ERROR: ${(err as Error).message}`);
    }
  }

  // Summary table
  out("");
  out("=== Summary ===");
  out(
    `${"model".padEnd(22)} ` +
    `${"avg_ms".padStart(7)} ` +
    `${"ttft".padStart(6)} ` +
    `${"t/s".padStart(7)} ` +
    `${"struct".padStart(7)} ` +
    `notes`
  );

  for (const r of results) {
    const failedTasks = r.tasks.filter(t => !t.structOk);
    const notes = failedTasks.map(t => `${t.id}: ${t.note}`).join("; ");

    out(
      `${r.model.padEnd(22)} ` +
      `${r.avgMs.toFixed(0).padStart(7)} ` +
      `${r.avgTtft.toFixed(0).padStart(6)} ` +
      `${r.avgTokPerSec.toFixed(1).padStart(7)} ` +
      `${(r.structOkCount + "/" + r.tasks.length).padStart(7)} ` +
      `${notes}`
    );
  }

  out("");
}

main().catch(console.error);
