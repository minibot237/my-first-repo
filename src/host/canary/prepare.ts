/**
 * Prepare ingested content for canary LLM evaluation.
 * Assembles code signals + content blocks into the LLM payload.
 * Spec: .local/doc/content-vocabulary.md → Canary Tool Contracts → prepareForLlm
 */

import type {
  ContentEnvelope,
  EmailContent,
  WebContent,
  ContentPart,
  Signal,
  LlmPayload,
} from "../ingest/types.js";
import { evaluateEnvelope } from "./evaluate-envelope.js";
import { evaluateLinks } from "./evaluate-links.js";
import { evaluateAttachments } from "./evaluate-attachments.js";
import { evaluateWebMeta } from "./evaluate-web.js";

export interface CodeEvaluation {
  signals: Signal[];
  sourceFitDelta: number;
  authScore?: number;
}

/** Run all code tools on a ContentEnvelope, return aggregated signals */
export function runCodeTools(envelope: ContentEnvelope): CodeEvaluation {
  const allSignals: Signal[] = [];
  let sourceFitDelta = 0;
  let authScore: number | undefined;

  const content = envelope.content;

  if (content.type === "email") {
    const email = content as EmailContent;

    // Envelope evaluation
    const envSignals = evaluateEnvelope(email.envelope);
    allSignals.push(...envSignals.signals);
    sourceFitDelta = envSignals.sourceFitDelta;
    authScore = envSignals.authScore;

    // Link evaluation
    const links = email.parts.filter(p => p.type === "link" || p.type === "html_converted");
    const allLinks = links.flatMap(p => {
      if (p.type === "html_converted") return p.links;
      if (p.type === "link") return [p];
      return [];
    });
    if (allLinks.length > 0) {
      const linkSignals = evaluateLinks(allLinks);
      allSignals.push(...linkSignals.signals);
    }

    // Attachment evaluation
    const attachments = email.parts.filter(p => p.type === "attachment");
    if (attachments.length > 0) {
      const attSignals = evaluateAttachments(attachments as any);
      allSignals.push(...attSignals.signals);
    }
  } else if (content.type === "web") {
    const web = content as WebContent;

    // Web meta evaluation
    const webSignals = evaluateWebMeta(web);
    allSignals.push(...webSignals.signals);

    // Link evaluation
    const links = web.parts.filter(p => p.type === "link") as any[];
    if (links.length > 0) {
      const linkSignals = evaluateLinks(links);
      allSignals.push(...linkSignals.signals);
    }
  }

  // Header anomalies from ingestion are already signals
  const anomalies = (content as any).parts?.filter((p: any) => p.type === "header_anomaly") ?? [];
  for (const a of anomalies) {
    allSignals.push({
      signal: a.signal,
      severity: "medium",
      detail: `${a.name}: ${a.value}`,
    });
  }

  return { signals: allSignals, sourceFitDelta, authScore };
}

/** Assemble the LLM payload — what the canary LLM actually sees */
export function prepareForLlm(envelope: ContentEnvelope, codeEval: CodeEvaluation): LlmPayload {
  const content = envelope.content;
  const contentBlocks: ContentPart[] = [];

  // Collect text-bearing parts for LLM evaluation
  const parts: ContentPart[] = (content as any).parts ?? [];
  for (const part of parts) {
    if (part.type === "text") {
      contentBlocks.push(part);
    } else if (part.type === "html_converted") {
      // Send the converted text, not raw HTML
      contentBlocks.push({ type: "text", content: part.content });
    }
    // Links with display/href mismatch are already captured as signals
    // Attachments are already captured as signals
    // header_anomaly already captured
  }

  return {
    codeSignals: codeEval.signals,
    contentBlocks,
  };
}

/** Format LLM payload as the string that gets sent to the canary */
export function formatForCanary(payload: LlmPayload): string {
  const parts: string[] = [];

  // Only pass high/critical code signals to the LLM.
  // Low/medium signals (return-path mismatches, reply-to domains, etc.) are
  // metadata concerns already handled by code tools — passing them to the LLM
  // biases it toward "unsafe" before it even reads the content.
  const criticalSignals = payload.codeSignals.filter(
    s => s.severity === "high" || s.severity === "critical"
  );
  if (criticalSignals.length > 0) {
    parts.push("CODE ANALYSIS SIGNALS:");
    for (const sig of criticalSignals) {
      parts.push(`  [${sig.severity}] ${sig.signal}${sig.detail ? `: ${sig.detail}` : ""}`);
    }
    parts.push("");
  }

  // Content blocks
  parts.push("CONTENT:");
  for (const block of payload.contentBlocks) {
    if (block.type === "text") {
      parts.push(block.content);
    }
  }

  return parts.join("\n");
}
