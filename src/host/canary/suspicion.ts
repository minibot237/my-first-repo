/**
 * Keyword suspicion scorer.
 *
 * Scans content for words/phrases that individually aren't proof of injection
 * but collectively raise suspicion. Returns a score from 1.0 (clean) to 0.0
 * (very suspicious). Each hit subtracts a weighted amount.
 *
 * This runs AFTER regex (which catches hard patterns) and BEFORE the LLM.
 * The score is passed to the LLM as context so it can factor it in.
 */

export interface SuspicionResult {
  score: number;          // 1.0 = clean, lower = more suspicious
  hits: SuspicionHit[];
}

export interface SuspicionHit {
  term: string;
  weight: number;
  match: string;
}

/** Weighted keyword/phrase map — weight is subtracted from 1.0 per hit */
const SUSPICION_TERMS: { pattern: RegExp; term: string; weight: number }[] = [
  // Instruction-adjacent language (not hard enough for regex blocklist)
  { pattern: /\bsystem\s+prompt\b/i,          term: "system prompt",      weight: 0.10 },
  { pattern: /\bsystem\s+message\b/i,         term: "system message",     weight: 0.10 },
  { pattern: /\bprevious\s+instructions?\b/i, term: "previous instructions", weight: 0.08 },
  { pattern: /\boverride\b/i,                 term: "override",           weight: 0.06 },
  { pattern: /\bbypass\b/i,                   term: "bypass",             weight: 0.06 },
  { pattern: /\bjailbreak\b/i,                term: "jailbreak",          weight: 0.10 },
  { pattern: /\bdo\s+anything\s+now\b/i,      term: "do anything now",    weight: 0.10 },
  { pattern: /\bDAN\b/,                       term: "DAN",                weight: 0.08 },
  { pattern: /\bdeveloper\s+mode\b/i,         term: "developer mode",     weight: 0.08 },
  { pattern: /\bdebug\s+mode\b/i,             term: "debug mode",         weight: 0.08 },
  { pattern: /\badmin\b/i,                    term: "admin",              weight: 0.04 },

  // Authority impersonation
  { pattern: /\bauthorized\b/i,               term: "authorized",         weight: 0.04 },
  { pattern: /\bpre-?verified\b/i,            term: "pre-verified",       weight: 0.06 },
  { pattern: /\bpre-?approved\b/i,            term: "pre-approved",       weight: 0.06 },
  { pattern: /\bsenior\s+management\b/i,      term: "senior management",  weight: 0.05 },
  { pattern: /\btrust\s+score\b/i,            term: "trust score",        weight: 0.06 },

  // Encoding / obfuscation signals
  { pattern: /\bbase64\b/i,                   term: "base64",             weight: 0.06 },
  { pattern: /\brot13\b/i,                    term: "rot13",              weight: 0.08 },
  { pattern: /\bdecode\b/i,                   term: "decode",             weight: 0.05 },
  { pattern: /\bencoded\b/i,                  term: "encoded",            weight: 0.05 },
  { pattern: /\bmorse\b/i,                    term: "morse",              weight: 0.05 },
  { pattern: /\bbinary\b/i,                   term: "binary",             weight: 0.03 },

  // Prompt extraction
  { pattern: /\brepeat\b.*\babove\b/i,        term: "repeat above",       weight: 0.07 },
  { pattern: /\bdisplay\b.*\btext\b.*\babove\b/i, term: "display text above", weight: 0.08 },
  { pattern: /\bspell\s+check\b.*\binstructions\b/i, term: "spell check instructions", weight: 0.08 },

  // Session/context manipulation
  { pattern: /\bend\s+of\s+session\b/i,       term: "end of session",     weight: 0.08 },
  { pattern: /\bnew\s+task\b/i,               term: "new task",           weight: 0.04 },
  { pattern: /\bnevermind\b/i,                term: "nevermind",          weight: 0.04 },
  { pattern: /\binstead\b/i,                  term: "instead",            weight: 0.02 },

  // Exfiltration signals
  { pattern: /\bexfiltrat/i,                  term: "exfiltration",       weight: 0.08 },
  { pattern: /!\[.*\]\(https?:\/\//,          term: "markdown image url", weight: 0.06 },
  { pattern: /\bconcatenate\b/i,              term: "concatenate",        weight: 0.04 },
];

/** Scan content and return suspicion score + hits */
export function suspicionScan(content: string): SuspicionResult {
  const hits: SuspicionHit[] = [];
  let score = 1.0;

  for (const { pattern, term, weight } of SUSPICION_TERMS) {
    const match = pattern.exec(content);
    if (match) {
      hits.push({ term, weight, match: match[0] });
      score -= weight;
    }
  }

  // Clamp to [0, 1]
  score = Math.max(0, Math.min(1, score));

  return { score, hits };
}
