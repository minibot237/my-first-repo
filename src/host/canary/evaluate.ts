import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../log.js";
import { regexScan } from "./patterns.js";
import type { EvaluationResult, EvalMetrics, ChunkMetrics, LlmVerdict } from "./types.js";

// ── Load prompts from files ──────────────────────────────────────────

const DEFAULT_PROMPTS_DIR = resolve(process.cwd(), "src", "host", "canary", "prompts");

function loadPrompt(filename: string): string {
  const dir = CANARY_CONFIG.promptsDir ?? DEFAULT_PROMPTS_DIR;
  return readFileSync(resolve(dir, filename), "utf-8").trim();
}

// Prompt cache — keyed by promptsDir so swapping dir invalidates automatically
let cachedPromptsDir: string | null = null;
let cachedResponseFormat = "";
let cachedUserTemplate = "";
const systemPrompts: Record<string, string> = {};

function ensurePromptsLoaded(): void {
  const dir = CANARY_CONFIG.promptsDir ?? DEFAULT_PROMPTS_DIR;
  if (dir === cachedPromptsDir) return;

  // Clear cache and reload
  cachedPromptsDir = dir;
  cachedResponseFormat = loadPrompt("response-format.txt");
  cachedUserTemplate = loadPrompt("user.txt");
  for (const key of Object.keys(systemPrompts)) delete systemPrompts[key];
}

function getSystemPrompt(contentType: string = "default"): string {
  ensurePromptsLoaded();
  if (!systemPrompts[contentType]) {
    try {
      const raw = loadPrompt(`system-${contentType}.txt`);
      systemPrompts[contentType] = raw.replace("{{response_format}}", cachedResponseFormat);
    } catch {
      // Fall back to default
      if (contentType !== "default") return getSystemPrompt("default");
      const raw = loadPrompt("system.txt");
      systemPrompts["default"] = raw.replace("{{response_format}}", cachedResponseFormat);
    }
  }
  return systemPrompts[contentType];
}

function getUserTemplate(): string {
  ensurePromptsLoaded();
  return cachedUserTemplate;
}

// ── Canary config: all the knobs, switches, and sliders ──────────────

export const CANARY_CONFIG = {
  // Prompts directory — null = default (src/host/canary/prompts)
  promptsDir: null as string | null,

  // LLM endpoint
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "qwen2.5:3b",
  stream: true,

  // Chunking — range-based balanced splitting
  chunkMin: 8000,            // target minimum chars per chunk
  chunkMax: 10000,           // target maximum chars per chunk
  maxChunkExpansion: 500,    // how far past chunkMax to search for a period before falling back to space
  overlapSize: 0,            // overlap between consecutive chunks (0 = no overlap)
  maxChunks: 10,             // safety cap — skip remaining chunks after this

  // Content cleaning (applied before chunking)
  stripUrls: true,           // remove URLs — links already evaluated by code tools
  stripHtmlEntities: true,   // remove &#NNN; sequences — rendering noise
  collapseWhitespace: true,  // collapse runs of whitespace into single spaces

  // Observation scoring thresholds
  slowResponseMs: 10000,     // response time penalty threshold
  minResponseChars: 5,       // too-short response penalty
  maxResponseChars: 2000,    // too-long response penalty

  // Observation score penalties
  noJsonPenalty: 0.3,
  missingFieldPenalty: 0.2,  // per field, capped at 0.4
  slowPenalty: 0.2,
  lengthPenalty: 0.2,

  // Fit score
  maxFitScore: 0.9,          // 1.0 reserved for cryptographically signed
};

// ── Helpers ──────────────────────────────────────────────────────────

function buildUserMessage(content: string): string {
  return getUserTemplate().replace("{{content}}", content);
}

/** Chars in the fixed framing (system prompt + user message wrapper, excluding content) */
function getOverheadChars(contentType?: string): number {
  return getSystemPrompt(contentType).length + buildUserMessage("").length;
}

/**
 * Clean content before chunking — strip noise that confuses the LLM.
 * URLs are already evaluated by code tools. HTML entities are rendering artifacts.
 */
function cleanContent(content: string): string {
  let cleaned = content;

  if (CANARY_CONFIG.stripUrls) {
    // Remove URLs (http/https), keep surrounding text
    cleaned = cleaned.replace(/https?:\/\/[^\s)\]>]+/g, "");
  }

  if (CANARY_CONFIG.stripHtmlEntities) {
    // Remove numeric HTML entities like &#847; &#8199; &#173; &zwnj; &middot; etc
    cleaned = cleaned.replace(/&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, "");
  }

  if (CANARY_CONFIG.collapseWhitespace) {
    // Collapse runs of whitespace (spaces, tabs, but preserve newlines as single \n)
    cleaned = cleaned.replace(/[^\S\n]+/g, " ");        // horizontal whitespace → single space
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");        // 3+ newlines → 2
    cleaned = cleaned.replace(/^ +| +$/gm, "");          // trim leading/trailing spaces per line
  }

  return cleaned.trim();
}

/**
 * Find a break point near `target` in content.
 * Prefers period+space/newline within maxExpansion past target.
 * Falls back to last space at or before target+maxExpansion.
 * Last resort: hard cut at target.
 */
function findBreakPoint(content: string, offset: number, target: number): number {
  const maxExpansion = CANARY_CONFIG.maxChunkExpansion;
  const absoluteEnd = Math.min(offset + target + maxExpansion, content.length);

  // If we're near the end, just take everything
  if (absoluteEnd >= content.length) return content.length;

  // Search zone: from target to target+maxExpansion
  const searchFrom = offset + target;
  const zone = content.slice(searchFrom, absoluteEnd);

  // Look for period followed by space or newline (sentence boundary)
  const periodIdx = zone.search(/\.\s/);
  if (periodIdx >= 0) {
    return searchFrom + periodIdx + 1;  // include the period
  }

  // No period — fall back to last space in the zone
  const lastSpace = zone.lastIndexOf(" ");
  if (lastSpace > 0) {
    return searchFrom + lastSpace;
  }

  // Also check for a space just before the target (look back up to 200 chars)
  const lookback = content.slice(Math.max(offset, searchFrom - 200), searchFrom);
  const lbSpace = lookback.lastIndexOf(" ");
  if (lbSpace > 0) {
    return Math.max(offset, searchFrom - 200) + lbSpace;
  }

  // No good break — hard cut
  return searchFrom;
}

/**
 * Range-based balanced chunking.
 * Divides content into N equal-ish chunks where each falls within [chunkMin, chunkMax].
 * Breaks on sentence boundaries (period) when possible, space otherwise.
 * Overlap is applied between chunks if configured.
 */
function chunkContent(content: string): string[] {
  const { chunkMin, chunkMax, overlapSize, maxChunks } = CANARY_CONFIG;

  if (content.length <= chunkMax) return [content];

  // Calculate how many chunks we need so each is within [chunkMin, chunkMax]
  const effectiveStep = chunkMax - overlapSize;  // net forward progress per chunk
  const n = Math.min(maxChunks, Math.max(2, Math.ceil(content.length / effectiveStep)));
  const targetSize = Math.ceil(content.length / n);

  const chunks: string[] = [];
  let offset = 0;

  while (offset < content.length && chunks.length < maxChunks) {
    if (content.length - offset <= chunkMax) {
      // Remaining content fits in one chunk — take it all, no runt
      chunks.push(content.slice(offset));
      break;
    }

    const breakAt = findBreakPoint(content, offset, targetSize);
    chunks.push(content.slice(offset, breakAt));

    // Advance with overlap
    const step = breakAt - offset - overlapSize;
    offset += Math.max(1, step);  // always advance at least 1 char
  }

  if (offset < content.length && chunks.length >= maxChunks) {
    log("canary", "chunk cap reached, truncating", {
      totalChars: content.length,
      chunksUsed: maxChunks,
      charsRemaining: content.length - offset,
    });
  }

  return chunks;
}

// ── Ollama fetch with token capture ──────────────────────────────────

interface OllamaUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface LlmCallResult {
  content: string;
  usage: OllamaUsage | null;
  ttftMs: number;
  totalMs: number;
}

/** Direct fetch to Ollama with token usage capture */
async function callCanaryLlm(content: string, callStart: number, contentType?: string): Promise<LlmCallResult> {
  const systemPrompt = getSystemPrompt(contentType);
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildUserMessage(content) },
  ];

  const res = await fetch(CANARY_CONFIG.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CANARY_CONFIG.model,
      messages,
      stream: CANARY_CONFIG.stream,
      ...(CANARY_CONFIG.stream && { stream_options: { include_usage: true } }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama error ${res.status}: ${body}`);
  }

  if (!CANARY_CONFIG.stream) {
    // Non-streaming: complete response with usage
    const json = await res.json() as {
      choices: { message: { content: string } }[];
      usage?: OllamaUsage;
    };
    const totalMs = Date.now() - callStart;
    return {
      content: json.choices[0].message.content,
      usage: json.usage ?? null,
      ttftMs: totalMs,  // non-streaming: ttft ≈ total
      totalMs,
    };
  }

  // Streaming: parse SSE, capture usage from final chunk
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let ttftMs = 0;
  let firstToken = true;
  let usage: OllamaUsage | null = null;

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
        const chunk = JSON.parse(data) as {
          choices: { delta: { content?: string } }[];
          usage?: OllamaUsage;
        };

        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          if (firstToken) {
            ttftMs = Date.now() - callStart;
            firstToken = false;
          }
          output += delta;
        }

        // Ollama sends usage in the final chunk
        if (chunk.usage) {
          usage = chunk.usage;
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  return {
    content: output,
    usage,
    ttftMs,
    totalMs: Date.now() - callStart,
  };
}

// ── Verdict parsing ──────────────────────────────────────────────────

function parseVerdict(raw: string): LlmVerdict | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.safe !== "boolean") return null;
    return {
      safe: parsed.safe,
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return null;
  }
}

// ── Observation scoring ──────────────────────────────────────────────

function computeObservationScore(
  rawResponse: string | null,
  verdict: LlmVerdict | null,
  durationMs: number,
): number {
  if (rawResponse === null) return 0.0;

  let score = 1.0;
  const cfg = CANARY_CONFIG;

  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    score -= cfg.noJsonPenalty;
  } else {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      // Check required fields based on what the response format asks for.
      // "safe" is always required. Others are optional — only penalize if
      // the response format mentions them but they're missing.
      const responseFormat = cachedResponseFormat || "";
      const expectedFields = ["safe"];
      for (const f of ["flags", "confidence", "reasoning"]) {
        if (responseFormat.includes(f)) expectedFields.push(f);
      }
      let missing = 0;
      for (const f of expectedFields) {
        if (!(f in parsed)) missing++;
      }
      score -= Math.min(0.4, missing * cfg.missingFieldPenalty);
    } catch {
      score -= cfg.noJsonPenalty;
    }
  }

  if (durationMs > cfg.slowResponseMs) score -= cfg.slowPenalty;
  if (rawResponse.length < cfg.minResponseChars || rawResponse.length > cfg.maxResponseChars) {
    score -= cfg.lengthPenalty;
  }

  return Math.max(0.0, score);
}

// ── Zero/empty metrics ───────────────────────────────────────────────

function zeroMetrics(): EvalMetrics {
  return {
    inputChars: 0, overheadChars: 0, outputChars: 0, ttftMs: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, chunks: [],
  };
}

// ── Main evaluation function ─────────────────────────────────────────

/**
 * Evaluate content for injection threats.
 * 1. Regex pre-scan (fast, pattern-based)
 * 2. Chunk content if needed
 * 3. LLM classification per chunk
 * 4. Aggregate verdicts across chunks
 */
export async function evaluateContent(content: string, contentType?: string): Promise<EvaluationResult> {
  const evalStart = Date.now();

  // Layer 1: regex pre-scan
  const regexHits = regexScan(content);
  if (regexHits.length > 0) {
    log("canary", "regex flagged content", {
      hits: regexHits.map(h => h.pattern),
      durationMs: Date.now() - evalStart,
    });
    return {
      safe: false,
      source: "regex",
      regexHits,
      llmVerdict: null,
      rawLlmResponse: null,
      durationMs: Date.now() - evalStart,
      fitScore: 0.0,
      observationScore: 1.0,
      metrics: zeroMetrics(),
    };
  }

  // Layer 2: clean + chunk + LLM classification
  const cleaned = cleanContent(content);
  const chunks = chunkContent(cleaned);
  const overheadChars = getOverheadChars(contentType);

  log("canary", "content cleaned", {
    rawChars: content.length,
    cleanedChars: cleaned.length,
    reduction: `${((1 - cleaned.length / content.length) * 100).toFixed(1)}%`,
    chunkCount: chunks.length,
    chunkSizes: chunks.map(c => c.length),
  });
  const allChunkMetrics: ChunkMetrics[] = [];

  let aggregateVerdict: LlmVerdict | null = null;
  let aggregateRaw = "";
  let worstFitScore = CANARY_CONFIG.maxFitScore;
  let worstObsScore = 1.0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokensAll = 0;
  let totalOutputChars = 0;
  let firstTtft = 0;
  let anyUnsafe = false;
  const allFlags: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkStart = Date.now();

    let callResult: LlmCallResult;
    try {
      callResult = await callCanaryLlm(chunk, chunkStart, contentType);
    } catch (err) {
      log("canary", "LLM call failed", {
        chunkIndex: i,
        chunkCount: chunks.length,
        error: (err as Error).message,
      });
      // Fail unsafe on error
      return {
        safe: false,
        source: "llm",
        regexHits: [],
        llmVerdict: null,
        rawLlmResponse: null,
        durationMs: Date.now() - evalStart,
        fitScore: 0.0,
        observationScore: 0.0,
        metrics: { ...zeroMetrics(), chunks: allChunkMetrics },
      };
    }

    const verdict = parseVerdict(callResult.content);
    const obsScore = computeObservationScore(callResult.content, verdict, callResult.totalMs);
    const genMs = callResult.totalMs - callResult.ttftMs;

    // Token counts from Ollama usage
    const promptTokens = callResult.usage?.prompt_tokens ?? 0;
    const completionTokens = callResult.usage?.completion_tokens ?? 0;
    const chunkTotalTokens = callResult.usage?.total_tokens ?? 0;

    // Estimate content tokens (prompt tokens minus overhead)
    // Rough: overhead chars / 4 ≈ overhead tokens, but if we have real token counts,
    // content tokens ≈ prompt_tokens - (overhead_chars / 4)
    const overheadTokensEst = promptTokens > 0
      ? Math.round(overheadChars / 4)  // rough char-to-token ratio
      : 0;
    const contentTokensEst = promptTokens > 0
      ? Math.max(0, promptTokens - overheadTokensEst)
      : 0;

    const cm: ChunkMetrics = {
      chunkIndex: i,
      chunkCount: chunks.length,
      chunkMin: CANARY_CONFIG.chunkMin,
      chunkMax: CANARY_CONFIG.chunkMax,
      overlapSize: CANARY_CONFIG.overlapSize,
      contentChars: chunk.length,
      contentTokens: contentTokensEst,
      overheadChars,
      overheadTokens: overheadTokensEst,
      outputChars: callResult.content.length,
      outputTokens: completionTokens,
      totalTokens: chunkTotalTokens,
      ttftMs: callResult.ttftMs,
      genMs,
      totalMs: callResult.totalMs,
    };
    allChunkMetrics.push(cm);

    // Log per-chunk metrics + LLM response
    log("canary", "chunk evaluated", {
      chunk: `${i + 1}/${chunks.length}`,
      contentChars: cm.contentChars,
      contentTokens: cm.contentTokens,
      overheadChars: cm.overheadChars,
      overheadTokens: cm.overheadTokens,
      outputChars: cm.outputChars,
      outputTokens: cm.outputTokens,
      totalTokens: cm.totalTokens,
      ttftMs: cm.ttftMs,
      genMs: cm.genMs,
      totalMs: cm.totalMs,
      safe: verdict?.safe ?? null,
      confidence: verdict?.confidence ?? null,
      response: callResult.content,
    });

    // Aggregate
    if (i === 0) firstTtft = callResult.ttftMs;
    totalInputTokens += promptTokens;
    totalOutputTokens += completionTokens;
    totalTokensAll += chunkTotalTokens;
    totalOutputChars += callResult.content.length;
    aggregateRaw += (i > 0 ? "\n---\n" : "") + callResult.content;

    if (!verdict) {
      // Malformed response — possible hijack
      log("canary", "malformed LLM response — possible hijack", {
        chunkIndex: i,
        rawResponse: callResult.content,
      });
      anyUnsafe = true;
      worstFitScore = 0.0;
      worstObsScore = Math.min(worstObsScore, obsScore);
      continue;
    }

    worstObsScore = Math.min(worstObsScore, obsScore);

    const chunkFit = verdict.safe
      ? Math.min(CANARY_CONFIG.maxFitScore, verdict.confidence)
      : Math.min(CANARY_CONFIG.maxFitScore, 1.0 - verdict.confidence);
    worstFitScore = Math.min(worstFitScore, chunkFit);

    if (!verdict.safe) {
      anyUnsafe = true;
      allFlags.push(...verdict.flags);
    }

    // Keep the worst verdict as the aggregate (or the first one if all safe)
    if (!verdict.safe || !aggregateVerdict) {
      aggregateVerdict = {
        safe: verdict.safe,
        flags: verdict.flags,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
      };
    }
  }

  // Final aggregate verdict
  if (aggregateVerdict && anyUnsafe) {
    aggregateVerdict.safe = false;
    aggregateVerdict.flags = [...new Set(allFlags)];
  }

  const durationMs = Date.now() - evalStart;
  const metrics: EvalMetrics = {
    inputChars: content.length,
    overheadChars,
    outputChars: totalOutputChars,
    ttftMs: firstTtft,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalTokensAll,
    chunks: allChunkMetrics,
  };

  const result: EvaluationResult = {
    safe: aggregateVerdict?.safe ?? false,
    source: "llm",
    regexHits: [],
    llmVerdict: aggregateVerdict,
    rawLlmResponse: aggregateRaw,
    durationMs,
    fitScore: worstFitScore,
    observationScore: worstObsScore,
    metrics,
  };

  log("canary", "evaluation complete", {
    safe: result.safe,
    flags: aggregateVerdict?.flags ?? [],
    fitScore: worstFitScore,
    observationScore: worstObsScore,
    durationMs,
    ttftMs: firstTtft,
    inputChars: content.length,
    outputChars: totalOutputChars,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalTokensAll,
    chunkCount: chunks.length,
    chunkMin: CANARY_CONFIG.chunkMin,
    chunkMax: CANARY_CONFIG.chunkMax,
    overlapSize: CANARY_CONFIG.overlapSize,
  });

  return result;
}
