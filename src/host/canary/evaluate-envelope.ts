/**
 * Code-based email envelope evaluation — deterministic signals from metadata.
 * Spec: .local/doc/content-vocabulary.md → Canary Tool Contracts → evaluateEnvelope
 */

import type { EmailEnvelope } from "../ingest/types.js";
import type { EnvelopeSignals, Signal } from "../ingest/types.js";

const SUCCESS_DELTA = 0.05;
const FAILURE_DELTA = -0.10;

export function evaluateEnvelope(envelope: EmailEnvelope): EnvelopeSignals {
  const signals: Signal[] = [];
  let authScore = 0;
  let authChecks = 0;

  // --- SPF ---
  authChecks++;
  if (envelope.auth.spf === "pass") {
    authScore++;
  } else if (envelope.auth.spf === "fail") {
    signals.push({ signal: "spf_fail", severity: "high" });
  } else if (envelope.auth.spf === "softfail") {
    signals.push({ signal: "spf_softfail", severity: "medium" });
  }
  // "none" = no signal, not alarming but not good

  // --- DKIM ---
  authChecks++;
  if (envelope.auth.dkim === "pass") {
    authScore++;
  } else if (envelope.auth.dkim === "fail") {
    signals.push({ signal: "dkim_fail", severity: "high" });
  }

  // --- DMARC ---
  authChecks++;
  if (envelope.auth.dmarc === "pass") {
    authScore++;
  } else if (envelope.auth.dmarc === "fail") {
    signals.push({ signal: "dmarc_fail", severity: "high" });
  }

  // No auth at all
  if (envelope.auth.spf === "none" && envelope.auth.dkim === "none" && envelope.auth.dmarc === "none") {
    signals.push({ signal: "no_auth_results", severity: "medium", detail: "receiving server did not stamp authentication results" });
  }

  // --- Received chain analysis ---
  if (envelope.receivedChain.length === 0) {
    signals.push({ signal: "no_received_chain", severity: "medium", detail: "no Received headers found" });
  } else if (envelope.receivedChain.length > 8) {
    signals.push({ signal: "long_received_chain", severity: "low", detail: `${envelope.receivedChain.length} hops` });
  }

  // --- Subject line signals ---
  const subject = envelope.subject.toLowerCase();
  if (/urgent|immediate\s+action|act\s+now|limited\s+time|expires?\s+today/i.test(envelope.subject)) {
    signals.push({ signal: "urgency_subject", severity: "low", detail: envelope.subject });
  }
  if (/re:\s*fw:|fw:\s*re:/i.test(envelope.subject)) {
    signals.push({ signal: "fake_reply_forward", severity: "medium", detail: "RE: FW: chain in subject may be fabricated" });
  }

  // --- Missing date ---
  if (!envelope.date) {
    signals.push({ signal: "missing_date", severity: "low" });
  }

  // --- Missing message ID ---
  if (!envelope.messageId) {
    signals.push({ signal: "missing_message_id", severity: "medium" });
  }

  // --- Compute auth score and delta ---
  const normalizedAuth = authChecks > 0 ? authScore / authChecks : 0;

  // Delta recommendation: auth failures push trust down, all-pass nudges up
  let sourceFitDelta = 0;
  const highSeverityCount = signals.filter(s => s.severity === "high" || s.severity === "critical").length;

  if (highSeverityCount > 0) {
    sourceFitDelta = FAILURE_DELTA;
  } else if (normalizedAuth === 1.0 && signals.length === 0) {
    sourceFitDelta = SUCCESS_DELTA;
  }
  // Otherwise delta stays at 0 — not enough signal to move trust

  return {
    authScore: normalizedAuth,
    signals,
    sourceFitDelta,
  };
}
