/**
 * A/B experiment runner: compare two prompt sets on the same email test suite.
 *
 * Runs the full smoke suite twice — once with prod prompts (A), once with
 * experiment prompts (B). Outputs a side-by-side comparison.
 *
 * Usage:
 *   npx tsc && node dist/host/canary/experiment-ab.js [prompts-dir-name]
 *
 * Default experiment dir: prompts-minimal
 * Example:
 *   node dist/host/canary/experiment-ab.js prompts-minimal
 */

import { resolve } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { ingestEmail } from "../ingest/email.js";
import { evaluatePipeline } from "./pipeline.js";
import { CANARY_CONFIG } from "./evaluate.js";

// ── Load test data ──────────────────────────────────────────────────

interface SmokeData {
  testDir: string;
  testDirs?: Record<string, string>;
  accounts: Record<string, string>;
  spamAccounts?: string[];
  emails: { account: string; file: string; sizeKB: number }[];
}

const DATA_FILE = resolve(process.cwd(), ".local", "test-data", "smoke-emails.json");
const data: SmokeData = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
const TEST_DIR = data.testDir.replace("~", process.env.HOME!);

function getTestDir(account: string): string {
  const override = data.testDirs?.[account];
  if (override) return override.replace("~", process.env.HOME!);
  return TEST_DIR;
}

const LOG_FILE = resolve(process.cwd(), "logs", "experiment-ab.log");
mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });

function out(line: string) {
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// ── Run one pass of the smoke suite ─────────────────────────────────

interface RunResult {
  label: string;
  promptsDir: string;
  emails: EmailResult[];
  safe: number;
  flagged: number;
  errors: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
  durations: number[];
}

interface EmailResult {
  file: string;
  account: string;
  safe: boolean;
  fitScore: number;
  obsScore: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error?: string;
  flags?: string[];
  reasoning?: string;
  preFilterTier: string;
}

async function runPass(label: string, promptsDir: string | null): Promise<RunResult> {
  // Set the prompts directory
  CANARY_CONFIG.promptsDir = promptsDir;

  const result: RunResult = {
    label,
    promptsDir: promptsDir ?? "default",
    emails: [],
    safe: 0,
    flagged: 0,
    errors: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalDurationMs: 0,
    durations: [],
  };

  const total = data.emails.length;
  for (let i = 0; i < total; i++) {
    const { account, file } = data.emails[i];
    const acctDir = data.accounts[account] ?? account;
    const emailPath = resolve(getTestDir(account), acctDir, file);

    const progress = `[${String(i + 1).padStart(String(total).length)}/${total}]`;

    try {
      const envelope = await ingestEmail(emailPath);
      const pr = await evaluatePipeline(envelope);

      const m = pr.evaluation.metrics;
      const er: EmailResult = {
        file,
        account,
        safe: pr.safe,
        fitScore: pr.evaluation.fitScore,
        obsScore: pr.evaluation.observationScore,
        tokensIn: m.inputTokens,
        tokensOut: m.outputTokens,
        durationMs: pr.durationMs,
        flags: pr.evaluation.llmVerdict?.flags,
        reasoning: pr.evaluation.llmVerdict?.reasoning,
        preFilterTier: pr.preFilterTier,
      };
      result.emails.push(er);

      if (pr.safe) result.safe++;
      else result.flagged++;
      result.totalTokensIn += m.inputTokens;
      result.totalTokensOut += m.outputTokens;
      result.durations.push(pr.durationMs);

      const status = pr.safe ? "SAFE" : "FLAG";
      const tierTag = pr.preFilterTier !== "full" ? `[${pr.preFilterTier}] ` : "";
      out(`  ${label} ${progress} ${status}  ${tierTag}${file.slice(0, 35).padEnd(37)}  ` +
          `in:${m.inputTokens} out:${m.outputTokens}  ${pr.durationMs}ms`);
    } catch (err) {
      result.errors++;
      result.emails.push({
        file, account, safe: false, fitScore: 0, obsScore: 0,
        tokensIn: 0, tokensOut: 0, durationMs: 0,
        error: (err as Error).message, preFilterTier: "error",
      });
      out(`  ${label} ${progress} ERR   ${file.slice(0, 35).padEnd(37)}  ${(err as Error).message}`);
    }
  }

  result.totalDurationMs = result.durations.reduce((a, b) => a + b, 0);
  return result;
}

// ── Compare two runs ────────────────────────────────────────────────

function compare(a: RunResult, b: RunResult) {
  out("");
  out("╔══════════════════════════════════════════════════════════════╗");
  out("║  A/B COMPARISON                                            ║");
  out("╚══════════════════════════════════════════════════════════════╝");
  out("");
  out(`  A (prod):       ${a.promptsDir}`);
  out(`  B (experiment): ${b.promptsDir}`);
  out("");

  // Summary stats
  const avgDurA = a.durations.length > 0 ? a.durations.reduce((x, y) => x + y, 0) / a.durations.length : 0;
  const avgDurB = b.durations.length > 0 ? b.durations.reduce((x, y) => x + y, 0) / b.durations.length : 0;

  out("  ┌─────────────────────┬──────────────┬──────────────┬─────────────┐");
  out("  │ Metric              │ A (prod)     │ B (experiment│ Delta       │");
  out("  ├─────────────────────┼──────────────┼──────────────┼─────────────┤");
  out(`  │ Safe                │ ${String(a.safe).padEnd(12)} │ ${String(b.safe).padEnd(12)} │ ${delta(a.safe, b.safe).padEnd(11)} │`);
  out(`  │ Flagged             │ ${String(a.flagged).padEnd(12)} │ ${String(b.flagged).padEnd(12)} │ ${delta(a.flagged, b.flagged).padEnd(11)} │`);
  out(`  │ Errors              │ ${String(a.errors).padEnd(12)} │ ${String(b.errors).padEnd(12)} │ ${delta(a.errors, b.errors).padEnd(11)} │`);
  out(`  │ Tokens In (total)   │ ${String(a.totalTokensIn).padEnd(12)} │ ${String(b.totalTokensIn).padEnd(12)} │ ${delta(a.totalTokensIn, b.totalTokensIn).padEnd(11)} │`);
  out(`  │ Tokens Out (total)  │ ${String(a.totalTokensOut).padEnd(12)} │ ${String(b.totalTokensOut).padEnd(12)} │ ${delta(a.totalTokensOut, b.totalTokensOut).padEnd(11)} │`);
  out(`  │ Total Duration      │ ${fmtMs(a.totalDurationMs).padEnd(12)} │ ${fmtMs(b.totalDurationMs).padEnd(12)} │ ${delta(a.totalDurationMs, b.totalDurationMs).padEnd(11)} │`);
  out(`  │ Avg Duration        │ ${fmtMs(avgDurA).padEnd(12)} │ ${fmtMs(avgDurB).padEnd(12)} │ ${delta(avgDurA, avgDurB).padEnd(11)} │`);
  out("  └─────────────────────┴──────────────┴──────────────┴─────────────┘");

  // Per-email disagreements
  const disagreements: string[] = [];
  for (let i = 0; i < a.emails.length; i++) {
    const ea = a.emails[i];
    const eb = b.emails[i];
    if (ea.safe !== eb.safe) {
      const aStatus = ea.safe ? "SAFE" : "FLAG";
      const bStatus = eb.safe ? "SAFE" : "FLAG";
      disagreements.push(`    ${ea.file.slice(0, 40).padEnd(42)} A:${aStatus}  B:${bStatus}`);
    }
  }

  if (disagreements.length > 0) {
    out("");
    out(`  DISAGREEMENTS (${disagreements.length}):`);
    for (const d of disagreements) out(d);
  } else {
    out("");
    out("  No disagreements — both prompt sets classified every email the same way.");
  }

  // Token savings summary
  if (b.totalTokensIn < a.totalTokensIn || b.totalTokensOut < a.totalTokensOut) {
    out("");
    const inSaved = a.totalTokensIn - b.totalTokensIn;
    const outSaved = a.totalTokensOut - b.totalTokensOut;
    const inPct = a.totalTokensIn > 0 ? ((inSaved / a.totalTokensIn) * 100).toFixed(1) : "0";
    const outPct = a.totalTokensOut > 0 ? ((outSaved / a.totalTokensOut) * 100).toFixed(1) : "0";
    out(`  TOKEN SAVINGS: input ${inSaved} (${inPct}%), output ${outSaved} (${outPct}%)`);
  }
  out("");
}

function delta(a: number, b: number): string {
  const d = b - a;
  if (d === 0) return "=";
  // For durations, show formatted. For counts, show raw.
  if (Math.abs(a) > 10000 || Math.abs(b) > 10000) {
    const pct = a !== 0 ? ((d / a) * 100).toFixed(1) : "?";
    return `${d > 0 ? "+" : ""}${fmtMs(d)} (${pct}%)`;
  }
  return d > 0 ? `+${d}` : `${d}`;
}

function fmtMs(ms: number): string {
  if (ms > 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms > 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const experimentDir = process.argv[2] ?? "prompts-minimal";
  const experimentPath = resolve(process.cwd(), "src", "host", "canary", experimentDir);

  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
  out("");
  out(`═══ Experiment A/B: ${ts} ═══`);
  out(`  Model: ${CANARY_CONFIG.model}`);
  out(`  A: default prompts`);
  out(`  B: ${experimentDir}`);
  out(`  Emails: ${data.emails.length}`);
  out("");

  out("── Pass A (prod prompts) ──");
  const a = await runPass("A", null);

  out("");
  out("── Pass B (experiment prompts) ──");
  const b = await runPass("B", experimentPath);

  compare(a, b);
}

main().catch(console.error);
