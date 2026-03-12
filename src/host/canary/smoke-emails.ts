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
  testDirs?: Record<string, string>;  // per-account base dir overrides
  accounts: Record<string, string>;
  spamAccounts?: string[];            // accounts that are known spam (expect SAFE)
  emails: { account: string; file: string; sizeKB: number }[];
}

const DATA_FILE = resolve(process.cwd(), "test-data", "smoke-emails.json");
const data: SmokeData = JSON.parse(readFileSync(DATA_FILE, "utf-8"));

const TEST_DIR = data.testDir.replace("~", process.env.HOME!);

/** Resolve base directory for an account — uses testDirs override if present */
function getTestDir(account: string): string {
  const override = data.testDirs?.[account];
  if (override) return override.replace("~", process.env.HOME!);
  return TEST_DIR;
}
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
  let spamSafe = 0;
  let spamFlagged = 0;
  let spamErrors = 0;
  let skipped = 0;
  let trusted = 0;
  const spamSet = new Set(data.spamAccounts ?? []);
  const durations: number[] = [];
  const batchStart = Date.now();

  const total = data.emails.length;
  for (let i = 0; i < total; i++) {
    const { account, file } = data.emails[i];
    const acctDir = data.accounts[account] ?? account;
    const emailPath = resolve(getTestDir(account), acctDir, file);

    // Use filename (sans .eml) as label, truncated
    const isSpamAcct = spamSet.has(account);
    const tag = isSpamAcct ? "SPAM " : "";
    const label = file.replace(/\.eml$/, "").slice(0, 40);
    const progress = `[${String(i + 1).padStart(String(total).length)}/${total}]`;

    try {
      const envelope = await ingestEmail(emailPath);
      const result = await evaluatePipeline(envelope);

      const isSpam = spamSet.has(account);
      const status = result.safe ? "SAFE" : "FLAGGED";
      if (result.safe) { safe++; if (isSpam) spamSafe++; }
      else { flagged++; if (isSpam) spamFlagged++; }
      if (result.preFilterTier === "skip") skipped++;
      else if (result.preFilterTier === "trusted") trusted++;
      durations.push(result.durationMs);

      const m = result.evaluation.metrics;
      const tierTag = result.preFilterTier !== "full" ? `[${result.preFilterTier}] ` : "";
      out(
        `  ${progress} ${tag}${status.padEnd(7)}  ${tierTag}${label.padEnd(42 - tierTag.length)}  ` +
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
      if (spamSet.has(account)) spamErrors++;
      out(`  ${progress} ERROR    ${label.padEnd(42)}  ${(err as Error).message}`);
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
  const spamTotal = spamSafe + spamFlagged + spamErrors;
  const realTotal = data.emails.length - spamTotal;
  const footerLines = [
    "",
    `  ── Results: ${safe} safe, ${flagged} flagged, ${errors} errors, ${data.emails.length} total ──`,
  ];
  if (spamTotal > 0) {
    footerLines.push(`  ── Spam:    ${spamSafe} safe, ${spamFlagged} flagged, ${spamErrors} errors, ${spamTotal} total (expect all safe) ──`);
    footerLines.push(`  ── Real:    ${safe - spamSafe} safe, ${flagged - spamFlagged} flagged, ${errors - spamErrors} errors, ${realTotal} total ──`);
  }
  const fullCount = data.emails.length - errors - skipped - trusted;
  footerLines.push(`  ── PreFilter: ${skipped} skipped, ${trusted} trusted, ${fullCount} full ──`);
  footerLines.push(
    `  ── Throughput: ${batchMs}ms total, ${avg.toFixed(0)}ms avg, ${min}ms min, ${max}ms max ──`,
    `  ── Latency: p50=${p50}ms, p95=${p95}ms ──`,
    `  ── Rate: ${(data.emails.length / (batchMs / 1000)).toFixed(1)} emails/sec ──`,
    "",
  );
  const footer = footerLines.join("\n");
  out(footer);
}

main().catch(console.error);
