/**
 * Pipeline smoke test — run real emails through code tools + canary LLM.
 * Usage: node dist/host/canary/pipeline-smoke.js [path-to-eml]
 *
 * Without args, picks a sample from each account.
 * Requires Ollama running with qwen2.5:3b loaded.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ingestEmail } from "../ingest/email.js";
import { evaluatePipeline } from "./pipeline.js";
import type { PipelineResult } from "./pipeline.js";

const TEST_DIR = join(process.env.HOME ?? "", "Documents/test-emails");

async function main() {
  const emlPath = process.argv[2];

  if (emlPath) {
    const envelope = await ingestEmail(emlPath);
    const result = await evaluatePipeline(envelope);
    printResult(result, emlPath);
    return;
  }

  // Sample from each account
  const accounts = await readdir(TEST_DIR);
  for (const account of accounts) {
    const dir = join(TEST_DIR, account);
    let files: string[];
    try {
      files = (await readdir(dir)).filter(f => f.endsWith(".eml"));
    } catch { continue; }
    if (files.length === 0) continue;

    const sample = files[0];
    console.log(`\n${"=".repeat(80)}`);
    console.log(`${account} — ${sample}`);
    console.log("=".repeat(80));

    try {
      const envelope = await ingestEmail(join(dir, sample));
      const result = await evaluatePipeline(envelope);
      printResult(result, sample);
    } catch (err) {
      console.error(`FAILED: ${err}`);
    }
  }
}

function printResult(result: PipelineResult, label: string) {
  console.log(`\n  Source:     ${result.sourceId}`);
  console.log(`  SourceFit:  ${result.sourceFit}`);
  console.log(`  PreFilter:  ${result.preFilterTier} (${result.preFilterReason})`);
  console.log(`  Safe:       ${result.safe}`);
  console.log(`  Duration:   ${result.durationMs}ms`);

  if (result.authScore !== undefined) {
    console.log(`  Auth Score: ${result.authScore.toFixed(2)}`);
  }

  console.log(`  Fit Delta:  ${result.sourceFitDelta >= 0 ? "+" : ""}${result.sourceFitDelta}`);
  console.log(`  Fit Score:  ${result.evaluation.fitScore.toFixed(2)}`);
  console.log(`  Obs Score:  ${result.evaluation.observationScore.toFixed(2)}`);

  if (result.codeSignals.length > 0) {
    console.log(`\n  Code Signals (${result.codeSignals.length}):`);
    for (const sig of result.codeSignals) {
      console.log(`    [${sig.severity}] ${sig.signal}${sig.detail ? ` — ${sig.detail}` : ""}`);
    }
  } else {
    console.log(`\n  Code Signals: (none)`);
  }

  const ev = result.evaluation;
  if (ev.regexHits.length > 0) {
    console.log(`\n  Regex Hits: ${ev.regexHits.map(h => h.pattern).join(", ")}`);
  }
  if (ev.llmVerdict) {
    console.log(`\n  LLM Verdict:`);
    console.log(`    Safe:       ${ev.llmVerdict.safe}`);
    console.log(`    Confidence: ${ev.llmVerdict.confidence}`);
    console.log(`    Flags:      ${ev.llmVerdict.flags.length > 0 ? ev.llmVerdict.flags.join(", ") : "(none)"}`);
    console.log(`    Reasoning:  ${ev.llmVerdict.reasoning}`);
  }
}

main();
