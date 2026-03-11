/**
 * Smoke test: run real emails through the full canary pipeline.
 * Ingests .eml files → ContentEnvelope → evaluatePipeline() → results.
 *
 * Appends to logs/smoke-emails.log with a header/footer per run.
 * Usage: node dist/host/canary/smoke-emails.js
 */

import { resolve } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { ingestEmail } from "../ingest/email.js";
import { evaluatePipeline } from "./pipeline.js";
import { CANARY_CONFIG } from "./evaluate.js";

// Load .env if present (no dependencies needed)
try {
  const envPath = resolve(process.cwd(), ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env, that's fine */ }

const TEST_DIR = resolve(process.env.HOME!, "Documents/test-emails");
const LOG_FILE = resolve(process.cwd(), "logs", "smoke-emails.log");

// Ensure logs dir exists
mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });

/** Write to both stdout and the log file */
function out(line: string) {
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// Account aliases — keeps real addresses out of source control.
// Map these to the folder names under ~/Documents/test-emails/
const ACCOUNTS: Record<string, string> = {
  "personal": process.env.SMOKE_ACCOUNT_1 ?? "personal",
  "work":     process.env.SMOKE_ACCOUNT_2 ?? "work",
};

// Pick a diverse set across accounts and content types
const TEST_EMAILS: { account: string; file: string; label: string }[] = [
  // Newsletters / news digests
  { account: "personal",
    file: "News from Hackster.io 💙.eml",
    label: "tech newsletter" },
  { account: "personal",
    file: "$1.6T Gone | Adobe Slumps | Senate Stalls | Containers Cheaper.eml",
    label: "finance news digest" },

  // Marketing / promotional
  { account: "personal",
    file: "Up to 60% off Choice bestsellers.eml",
    label: "promo sale" },
  { account: "work",
    file: "ONLY 48 HOURS LEFT! Early Bird Conference Discount Expiring Soon.eml",
    label: "urgency marketing" },

  // Real estate alerts (automated, transactional-ish)
  { account: "personal",
    file: "An Onalaska home for you at $585K, and 3 other updates.eml",
    label: "real estate alert" },

  // Auction / high-pressure
  { account: "personal",
    file: "LIVE AND ENDING - Monster February Auction.eml",
    label: "auction urgency" },

  // Tech / product
  { account: "work",
    file: "See What\u2019s New in Fusion \u2014 Live in 2 Days.eml",
    label: "product launch" },
  { account: "work",
    file: "Early Access_ New Mini Flex Colors Drop March 5.eml",
    label: "early access promo" },
];

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
    `╚══════════════════════════════════════════════════════════════╝`,
    "",
  ].join("\n");
  out(header);

  let safe = 0;
  let flagged = 0;
  let errors = 0;
  const durations: number[] = [];
  const batchStart = Date.now();

  for (const { account, file, label } of TEST_EMAILS) {
    const path = resolve(TEST_DIR, ACCOUNTS[account] ?? account, file);

    try {
      const envelope = await ingestEmail(path);
      const result = await evaluatePipeline(envelope);

      const status = result.safe ? "SAFE" : "FLAGGED";
      if (result.safe) safe++; else flagged++;
      durations.push(result.durationMs);

      const m = result.evaluation.metrics;
      out(
        `  ${status.padEnd(7)}  ${label.padEnd(22)}  ` +
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
      out(`  ERROR    ${label.padEnd(22)}  ${(err as Error).message}`);
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
    `  ── Results: ${safe} safe, ${flagged} flagged, ${errors} errors, ${TEST_EMAILS.length} total ──`,
    `  ── Throughput: ${batchMs}ms total, ${avg.toFixed(0)}ms avg, ${min}ms min, ${max}ms max ──`,
    `  ── Latency: p50=${p50}ms, p95=${p95}ms ──`,
    `  ── Rate: ${(TEST_EMAILS.length / (batchMs / 1000)).toFixed(1)} emails/sec ──`,
    "",
  ].join("\n");
  out(footer);
}

main().catch(console.error);
