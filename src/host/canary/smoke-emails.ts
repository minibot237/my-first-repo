/**
 * Smoke test: run real emails through the full canary pipeline.
 * Ingests .eml files → ContentEnvelope → evaluatePipeline() → results.
 *
 * Test data lives in test-data/smoke-emails.json (gitignored).
 * Appends to logs/smoke-emails.log with a header/footer per run.
 * Usage: node dist/host/canary/smoke-emails.js
 */

import { resolve } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { ingestEmail } from "../ingest/email.js";
import { evaluatePipeline } from "./pipeline.js";
import { CANARY_CONFIG } from "./evaluate.js";

// ── Load test data from JSON ─────────────────────────────────────────

interface SmokeData {
  testDir: string;
  accounts: Record<string, string>;
  emails: { account: string; file: string; sizeKB: number }[];
}

const DATA_FILE = resolve(process.cwd(), "test-data", "smoke-emails.json");
const data: SmokeData = JSON.parse(readFileSync(DATA_FILE, "utf-8"));

const TEST_DIR = data.testDir.replace("~", process.env.HOME!);
const LOG_FILE = resolve(process.cwd(), "logs", "smoke-emails.log");

// Ensure logs dir exists
mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });

/** Write to both stdout and the log file */
function out(line: string) {
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

async function main() {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
  const cfg = CANARY_CONFIG;

  // ── Run header ──
  const header = [
    "",
    "",
    `╔══════════════════════════════════════════════════════════════╗`,
    `║  SMOKE RUN  ${ts}                          ║`,
    `║  model: ${cfg.model.padEnd(20)}  stream: ${String(cfg.stream).padEnd(14)}  ║`,
    `║  chunks: [${cfg.chunkMin}-${cfg.chunkMax}]  overlap: ${String(cfg.overlapSize).padEnd(5)}  expand: ${String(cfg.maxChunkExpansion).padEnd(5)} ║`,
    `║  clean: urls=${cfg.stripUrls} entities=${cfg.stripHtmlEntities} collapse=${cfg.collapseWhitespace}   ║`,
    `║  emails: ${data.emails.length}                                                ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    "",
  ].join("\n");
  out(header);

  let safe = 0;
  let flagged = 0;
  let errors = 0;
  const durations: number[] = [];
  const batchStart = Date.now();

  for (const { account, file } of data.emails) {
    const acctDir = data.accounts[account] ?? account;
    const emailPath = resolve(TEST_DIR, acctDir, file);

    // Use filename (sans .eml) as label, truncated
    const label = file.replace(/\.eml$/, "").slice(0, 40);

    try {
      const envelope = await ingestEmail(emailPath);
      const result = await evaluatePipeline(envelope);

      const status = result.safe ? "SAFE" : "FLAGGED";
      if (result.safe) safe++; else flagged++;
      durations.push(result.durationMs);

      const m = result.evaluation.metrics;
      out(
        `  ${status.padEnd(7)}  ${label.padEnd(42)}  ` +
        `fit:${result.evaluation.fitScore.toFixed(2)}  ` +
        `obs:${result.evaluation.observationScore.toFixed(2)}  ` +
        `signals:${result.codeSignals.length}  ` +
        `chunks:${m.chunks.length}  ` +
        `tokens:${m.totalTokens}  ` +
        `(${result.durationMs}ms)`
      );

      // Per-chunk breakdown
      for (const c of m.chunks) {
        out(
          `           chunk ${c.chunkIndex + 1}/${c.chunkCount}  ` +
          `content:${c.contentChars}c/${c.contentTokens}t  ` +
          `overhead:${c.overheadChars}c/${c.overheadTokens}t  ` +
          `out:${c.outputChars}c/${c.outputTokens}t  ` +
          `total:${c.totalTokens}t  ` +
          `ttft:${c.ttftMs}ms  gen:${c.genMs}ms  wall:${c.totalMs}ms`
        );
      }

      // Show details for flagged items
      if (!result.safe) {
        if (result.evaluation.llmVerdict) {
          out(`           LLM: flags=[${result.evaluation.llmVerdict.flags.join(", ")}]`);
          out(`           reasoning: ${result.evaluation.llmVerdict.reasoning}`);
        }
        if (result.evaluation.regexHits.length > 0) {
          out(`           regex: [${result.evaluation.regexHits.map(h => h.pattern).join(", ")}]`);
        }
        const critical = result.codeSignals.filter(s => s.severity === "critical");
        if (critical.length > 0) {
          out(`           critical signals: ${critical.map(s => s.signal).join(", ")}`);
        }
      }
    } catch (err) {
      errors++;
      out(`  ERROR    ${label.padEnd(42)}  ${(err as Error).message}`);
    }
  }

  const batchMs = Date.now() - batchStart;
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const min = durations.length > 0 ? Math.min(...durations) : 0;
  const max = durations.length > 0 ? Math.max(...durations) : 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

  // ── Run footer ──
  const footer = [
    "",
    `  ── Results: ${safe} safe, ${flagged} flagged, ${errors} errors, ${data.emails.length} total ──`,
    `  ── Throughput: ${batchMs}ms total, ${avg.toFixed(0)}ms avg, ${min}ms min, ${max}ms max ──`,
    `  ── Latency: p50=${p50}ms, p95=${p95}ms ──`,
    `  ── Rate: ${(data.emails.length / (batchMs / 1000)).toFixed(1)} emails/sec ──`,
    "",
  ].join("\n");
  out(footer);
}

main().catch(console.error);
