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
}
