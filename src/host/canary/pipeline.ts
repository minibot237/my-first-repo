/**
 * Full canary evaluation pipeline for ingested content.
 * ContentEnvelope → code tools → LLM evaluation → PipelineResult
 *
 * This is the main entry point for evaluating ingested content.
 * It replaces direct use of evaluateContent() for structured content.
 */

import { log } from "../log.js";
import { evaluateContent } from "./evaluate.js";
import { runCodeTools, prepareForLlm, formatForCanary } from "./prepare.js";
import type { CodeEvaluation } from "./prepare.js";
import type { EvaluationResult } from "./types.js";
import type { ContentEnvelope, Signal } from "../ingest/types.js";

export interface PipelineResult {
  /** Content envelope ID */
  contentId: string;
  /** Source identity (sender, domain, etc.) */
  sourceId: string;
  /** Current source trust score (from envelope) */
  sourceFit: number;
  /** Code tool signals */
  codeSignals: Signal[];
  /** Recommended source trust delta from code tools */
  sourceFitDelta: number;
  /** Auth score for email (0-1, undefined for non-email) */
  authScore?: number;
  /** Canary LLM evaluation result */
  evaluation: EvaluationResult;
  /** Overall safe determination (code + LLM combined) */
  safe: boolean;
  /** Total pipeline duration */
  durationMs: number;
}

/**
 * Run the full canary pipeline on ingested content.
 *
 * 1. Run code tools (deterministic signals from metadata)
 * 2. Prepare content for LLM (assemble signals + content blocks)
 * 3. Run canary LLM evaluation (regex pre-scan + LLM classification)
 * 4. Combine results
 */
export async function evaluatePipeline(envelope: ContentEnvelope): Promise<PipelineResult> {
  const start = Date.now();

  // Step 1: Code tools
  const codeEval = runCodeTools(envelope);

  log("canary", "code tools complete", {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    signalCount: codeEval.signals.length,
    highSeverity: codeEval.signals.filter(s => s.severity === "high" || s.severity === "critical").length,
    sourceFitDelta: codeEval.sourceFitDelta,
    authScore: codeEval.authScore,
  });

  // Step 2: Prepare LLM payload
  const payload = prepareForLlm(envelope, codeEval);
  const canaryInput = formatForCanary(payload);

  // Step 3: Run canary LLM (includes regex pre-scan)
  // Pass content type so the right system prompt is used
  const evaluation = await evaluateContent(canaryInput, envelope.content.type);

  // Step 4: Combine — content is unsafe if code tools found critical signals OR LLM says unsafe
  const criticalCodeSignals = codeEval.signals.filter(s => s.severity === "critical");
  const safe = evaluation.safe && criticalCodeSignals.length === 0;

  const result: PipelineResult = {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    sourceFit: envelope.sourceFit,
    codeSignals: codeEval.signals,
    sourceFitDelta: codeEval.sourceFitDelta,
    authScore: codeEval.authScore,
    evaluation,
    safe,
    durationMs: Date.now() - start,
  };

  log("canary", "pipeline complete", {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    safe: result.safe,
    codeSignals: codeEval.signals.length,
    fitScore: evaluation.fitScore,
    observationScore: evaluation.observationScore,
    durationMs: result.durationMs,
  });

  return result;
}
