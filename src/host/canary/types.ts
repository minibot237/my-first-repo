/** Result of a regex pre-scan hit */
export interface RegexHit {
  pattern: string;    // name of the pattern that matched
  match: string;      // the matched text
  index: number;      // position in the content
}

/** Verdict from the canary LLM classifier */
export interface LlmVerdict {
  safe: boolean;
  flags: string[];       // what it detected, e.g. ["prompt_injection", "instruction_override"]
  confidence: number;    // 0-1
  reasoning: string;     // brief explanation
}

/** Per-chunk metrics from a single LLM call */
export interface ChunkMetrics {
  chunkIndex: number;        // 0-based
  chunkCount: number;        // total chunks for this content
  chunkMin: number;           // configured chunk min (chars)
  chunkMax: number;           // configured chunk max (chars)
  overlapSize: number;        // configured overlap (chars)
  contentChars: number;      // content chars in this chunk
  contentTokens: number;     // content tokens (from Ollama usage, 0 if unavailable)
  overheadChars: number;     // system prompt + framing chars
  overheadTokens: number;    // prompt_tokens - content_tokens estimate
  outputChars: number;       // LLM response chars
  outputTokens: number;      // completion_tokens from Ollama usage
  totalTokens: number;       // prompt_tokens + completion_tokens
  ttftMs: number;            // time to first token
  genMs: number;             // generation time (total - ttft)
  totalMs: number;           // wall clock for this chunk
}

/** Aggregated metrics across all chunks */
export interface EvalMetrics {
  inputChars: number;         // total content chars sent to LLM
  overheadChars: number;      // system prompt + user message framing chars
  outputChars: number;        // total LLM response chars
  ttftMs: number;             // time to first token (first chunk)
  inputTokens: number;        // total prompt tokens across chunks
  outputTokens: number;       // total completion tokens across chunks
  totalTokens: number;        // total tokens across chunks
  chunks: ChunkMetrics[];     // per-chunk breakdown
}

/** Full evaluation result combining regex + LLM layers */
export interface EvaluationResult {
  safe: boolean;              // final determination
  source: "regex" | "llm";   // which layer made the call
  regexHits: RegexHit[];      // always populated (even if empty)
  llmVerdict: LlmVerdict | null;  // null if regex short-circuited
  rawLlmResponse: string | null;  // the raw model output for monitoring
  durationMs: number;
  fitScore: number;           // 0.0–0.9, trust level from canary LLM (min of chunks)
  observationScore: number;   // 0.0–1.0, supervisor's assessment of canary behavior
  metrics: EvalMetrics;       // size and timing breakdown
}
