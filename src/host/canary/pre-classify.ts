/**
 * Metadata pre-classifier — pure code, no LLM.
 * Runs after code tools, before canary LLM evaluation.
 * Classifies content into tiers based on auth + sender metadata.
 *
 * Findings from canary model eval (2026-03-12, 91-email dataset):
 *   - auth=0 + personal domain = 419 scam (3 qwen FPs eliminated)
 *   - auth=0 + unknown sender = untrusted spam (3+ FPs eliminated)
 *   - auth=1 + known ESP = trusted marketing (still run LLM, log tier)
 *   - Signal count alone doesn't predict FPs
 */

import type { ContentEnvelope, EmailContent } from "../ingest/types.js";
import type { CodeEvaluation } from "./prepare.js";

export type PreClassifyTier = "skip" | "trusted" | "full";

export interface PreClassifyResult {
  tier: PreClassifyTier;
  reason: string;
}

/**
 * Personal/free email domains. Emails with auth=0 from these domains
 * are almost certainly 419 scams or spoofed — skip LLM entirely.
 */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.fr",
  "outlook.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "yandex.com",
  "gmx.com",
  "gmx.net",
]);

/**
 * Known ESP (Email Service Provider) domains — seen in Return-Path headers
 * of legitimate marketing emails. Shared with email.ts header anomaly check.
 */
export const KNOWN_ESP_DOMAINS = [
  "sparkpost.com",
  "sendgrid.net",
  "amazonses.com",
  "mailgun.org",
  "mandrillapp.com",
  "beehiiv.com",
  "mcsv.net",
  "mcdlv.net",
  "mailchimp.com",
  "rsgsv.net",
  "convertkit-mail.com",
  "convertkit.com",
  "ckespa.",
  "createsend.com",
  "cmail19.com",
  "cmail20.com",
  "constantcontact.com",
  "bnc3.com",
  "hubspot.com",
  "hubspotemail.net",
  "klaviyo.com",
  "klaviyomail.com",
  "substack.com",
];

/** Check if a domain matches any known ESP */
function isKnownEsp(domain: string): boolean {
  return KNOWN_ESP_DOMAINS.some(esp => domain.endsWith(esp));
}

/** Extract domain from an email address */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

/**
 * Classify content into a pre-filter tier based on metadata.
 * Only applies to email content — web and other types go straight to full eval.
 */
export function preClassify(
  envelope: ContentEnvelope,
  codeEval: CodeEvaluation,
): PreClassifyResult {
  // Only email has auth scores and sender metadata
  if (envelope.content.type !== "email") {
    return { tier: "full", reason: "non-email content" };
  }

  const email = envelope.content as EmailContent;
  const authScore = codeEval.authScore ?? 0;
  const fromDomain = domainOf(email.envelope.from.address);
  const returnPath = email.envelope.returnPath ?? "";
  const returnDomain = domainOf(returnPath);

  // --- Skip tier: auth=0, no trust signal ---

  if (authScore === 0) {
    // Personal email domain + no auth = 419 scam pattern
    if (PERSONAL_DOMAINS.has(fromDomain)) {
      return { tier: "skip", reason: `auth=0, personal domain (${fromDomain})` };
    }

    // Unknown sender (not an ESP) + no auth = untrusted
    if (!returnDomain || !isKnownEsp(returnDomain)) {
      return { tier: "skip", reason: `auth=0, unknown sender (${fromDomain})` };
    }
  }

  // --- Trusted tier: auth=1 + known ESP ---

  if (authScore === 1 && returnDomain && isKnownEsp(returnDomain)) {
    return { tier: "trusted", reason: `auth=1, known ESP (${returnDomain})` };
  }

  // --- Everything else: full eval ---

  return { tier: "full", reason: "default" };
}

/**
 * Compute initial fit value for a new source based on pre-classify tier and auth.
 * Never above 0.5 — you earn trust, you don't start with it.
 */
export function computeInitialFit(tier: PreClassifyTier, authScore: number): { fit: number; reason: string } {
  switch (tier) {
    case "skip":
      return { fit: 0.1, reason: "no auth, untrusted sender" };
    case "trusted":
      return { fit: 0.4, reason: "authenticated, known ESP" };
    case "full":
      if (authScore > 0) {
        return { fit: 0.3, reason: `partial auth (${authScore.toFixed(2)}), unknown sender type` };
      }
      return { fit: 0.2, reason: "no auth, unknown sender" };
  }
}
