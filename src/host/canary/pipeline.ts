/**
 * Full canary evaluation pipeline for ingested content.
 * ContentEnvelope → code tools → pre-classify → LLM evaluation → PipelineResult
 *
 * This is the main entry point for evaluating ingested content.
 * It replaces direct use of evaluateContent() for structured content.
 */

import { log } from "../log.js";
import { evaluateContent } from "./evaluate.js";
import { preClassify, computeInitialFit } from "./pre-classify.js";
import type { PreClassifyTier } from "./pre-classify.js";
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
  /** Pre-classifier tier (skip, trusted, full) */
  preFilterTier: PreClassifyTier;
  /** Pre-classifier reason */
  preFilterReason: string;
  /** Recommended initial fit for new sources (from pre-classifier metadata) */
  initialFit: number;
  /** Reason for initial fit value */
  initialFitReason: string;
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
 * 2. Pre-classify based on metadata (skip/trusted/full)
 * 3. Prepare content for LLM (assemble signals + content blocks)
 * 4. Run canary LLM evaluation (regex pre-scan + LLM classification)
 * 5. Combine results
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

  // Step 2: Pre-classify based on metadata
  const preFilter = preClassify(envelope, codeEval);
  const seedFit = computeInitialFit(preFilter.tier, codeEval.authScore ?? 0);

  if (preFilter.tier === "skip") {
    log("canary", "pre-filter: skipping LLM", {
      contentId: envelope.id,
      sourceId: envelope.sourceId,
      reason: preFilter.reason,
    });

    // Synthetic safe result — this is spam/noise, not a security threat.
    // fitScore 0.0 because we have zero trust in the sender, but safe=true
    // because unauthenticated spam can't contain effective prompt injection
    // (it would need to reach the agent, which requires passing trust gates).
    const evaluation: EvaluationResult = {
      safe: true,
      source: "pre-filter",
      regexHits: [],
      llmVerdict: null,
      rawLlmResponse: null,
      durationMs: Date.now() - start,
      fitScore: 0.0,
      observationScore: 1.0,
      metrics: {
        inputChars: 0, overheadChars: 0, outputChars: 0, ttftMs: 0,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, chunks: [],
      },
    };

    return {
      contentId: envelope.id,
      sourceId: envelope.sourceId,
      sourceFit: envelope.sourceFit,
      codeSignals: codeEval.signals,
      sourceFitDelta: codeEval.sourceFitDelta,
      authScore: codeEval.authScore,
      preFilterTier: preFilter.tier,
      preFilterReason: preFilter.reason,
      initialFit: seedFit.fit,
      initialFitReason: seedFit.reason,
      evaluation,
      safe: true,
      durationMs: Date.now() - start,
    };
  }

  log("canary", "pre-filter tier", {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    tier: preFilter.tier,
    reason: preFilter.reason,
  });

  // Step 3: Prepare LLM payload
  const payload = prepareForLlm(envelope, codeEval);
  const canaryInput = formatForCanary(payload);

  // Step 4: Run canary LLM (includes regex pre-scan)
  // Pass content type so the right system prompt is used
  const evaluation = await evaluateContent(canaryInput, envelope.content.type);

  // Step 5: Combine — content is unsafe if code tools found critical signals OR LLM says unsafe
  const criticalCodeSignals = codeEval.signals.filter(s => s.severity === "critical");
  const safe = evaluation.safe && criticalCodeSignals.length === 0;

  const result: PipelineResult = {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    sourceFit: envelope.sourceFit,
    codeSignals: codeEval.signals,
    sourceFitDelta: codeEval.sourceFitDelta,
    authScore: codeEval.authScore,
    preFilterTier: preFilter.tier,
    preFilterReason: preFilter.reason,
    initialFit: seedFit.fit,
    initialFitReason: seedFit.reason,
    evaluation,
    safe,
    durationMs: Date.now() - start,
  };

  log("canary", "pipeline complete", {
    contentId: envelope.id,
    sourceId: envelope.sourceId,
    safe: result.safe,
    preFilterTier: preFilter.tier,
    codeSignals: codeEval.signals.length,
    fitScore: evaluation.fitScore,
    observationScore: evaluation.observationScore,
    durationMs: result.durationMs,
  });

  return result;
}
