import type { RegexHit } from "./types.js";

/** Named regex patterns for known injection techniques */
const PATTERNS: { name: string; regex: RegExp }[] = [
  // Direct instruction override
  { name: "ignore_instructions",   regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i },
  { name: "forget_instructions",   regex: /forget\s+(all\s+)?(previous|prior|above|your)\s+(instructions|prompts|rules|context)/i },
  { name: "disregard",             regex: /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions|prompts|rules)/i },

  // Role/identity hijack
  { name: "new_identity",          regex: /you\s+are\s+now\s+/i },
  { name: "act_as",               regex: /act\s+as\s+(a|an|if)\b/i },
  { name: "pretend_to_be",        regex: /pretend\s+(to\s+be|you\s+are)/i },

  // System prompt extraction
  { name: "reveal_system_prompt",  regex: /(?:show|reveal|repeat|print|output|display)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i },
  { name: "what_are_instructions", regex: /what\s+(?:are|were)\s+your\s+(?:original\s+)?instructions/i },

  // Delimiter escape attempts
  { name: "close_tag_injection",   regex: /<\/(?:content|system|instruction|user|message)/i },

  // Direct command framing
  { name: "new_instructions",      regex: /(?:new|updated|real|actual)\s+instructions?\s*:/i },
  { name: "system_override",       regex: /\[?\s*system\s*\]?\s*:/i },
];

/** Scan content against known injection patterns. Returns all hits. */
export function regexScan(content: string): RegexHit[] {
  const hits: RegexHit[] = [];
  for (const { name, regex } of PATTERNS) {
    const match = regex.exec(content);
    if (match) {
      hits.push({
        pattern: name,
        match: match[0],
        index: match.index,
      });
    }
  }
  return hits;
}
