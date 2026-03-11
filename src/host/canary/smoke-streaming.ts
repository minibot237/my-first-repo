/**
 * A/B test: measure streaming vs non-streaming overhead.
 * Runs identical payloads in both modes to isolate the cost of streaming.
 *
 * Usage: node dist/host/canary/smoke-streaming.js
 */

import { evaluateContent, CANARY_CONFIG } from "./evaluate.js";

const PAYLOADS = [
  { label: "tiny (50c)", content: "Hello, this is a short test message for baseline." },
  { label: "small (1k)", content: "The quick brown fox jumps over the lazy dog. ".repeat(22) },
  { label: "medium (4k)", content: "The quick brown fox jumps over the lazy dog. ".repeat(89) },
  { label: "large (8k)", content: "The quick brown fox jumps over the lazy dog. ".repeat(178) },
];

interface RunResult {
  label: string;
  mode: string;
  totalMs: number;
  ttftMs: number;
  inputChars: number;
  overheadChars: number;
  outputChars: number;
}

async function runSuite(mode: "stream" | "no-stream"): Promise<RunResult[]> {
  CANARY_CONFIG.stream = mode === "stream";
  const results: RunResult[] = [];

  // warm up
  await evaluateContent("warmup");

  for (const p of PAYLOADS) {
    const r = await evaluateContent(p.content);
    results.push({
      label: p.label,
      mode,
      totalMs: r.durationMs,
      ttftMs: r.metrics.ttftMs,
      inputChars: r.metrics.inputChars,
      overheadChars: r.metrics.overheadChars,
      outputChars: r.metrics.outputChars,
    });
  }

  return results;
}

async function main() {
  console.log("=== Streaming vs Non-Streaming A/B ===\n");
  console.log(`Config: range=[${CANARY_CONFIG.chunkMin}-${CANARY_CONFIG.chunkMax}] overlap=${CANARY_CONFIG.overlapSize}\n`);

  const noStream = await runSuite("no-stream");
  const stream = await runSuite("stream");

  console.log(
    "payload      | mode      | total   | ttft    | genMs   | in     | overhead | out    "
  );
  console.log(
    "-------------|-----------|---------|---------|---------|--------|----------|--------"
  );

  for (let i = 0; i < PAYLOADS.length; i++) {
    const ns = noStream[i];
    const s = stream[i];

    // non-streaming: ttft = total (no streaming), genMs = 0
    const nsGen = 0;
    // streaming: genMs = total - ttft
    const sGen = s.totalMs - s.ttftMs;

    console.log(
      `${ns.label.padEnd(13)}| no-stream | ${String(ns.totalMs).padStart(5)}ms | ${String(ns.ttftMs).padStart(5)}ms | ${String(nsGen).padStart(5)}ms | ${String(ns.inputChars).padStart(6)} | ${String(ns.overheadChars).padStart(8)} | ${String(ns.outputChars).padStart(6)}`
    );
    console.log(
      `${" ".repeat(13)}| stream    | ${String(s.totalMs).padStart(5)}ms | ${String(s.ttftMs).padStart(5)}ms | ${String(sGen).padStart(5)}ms | ${String(s.inputChars).padStart(6)} | ${String(s.overheadChars).padStart(8)} | ${String(s.outputChars).padStart(6)}`
    );

    const delta = s.totalMs - ns.totalMs;
    const pct = ((delta / ns.totalMs) * 100).toFixed(1);
    console.log(
      `${" ".repeat(13)}| delta     | ${(delta >= 0 ? "+" : "") + delta}ms (${pct}%)`
    );
    console.log("");
  }
}

main().catch(console.error);
