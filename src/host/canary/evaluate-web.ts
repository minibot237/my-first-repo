/**
 * Code-based web content evaluation — deterministic signals from web metadata.
 * Spec: docs/content-vocabulary.md → Canary Tool Contracts → evaluateWebMeta
 */

import type { WebContent } from "../ingest/types.js";
import type { WebSignals, Signal } from "../ingest/types.js";

export function evaluateWebMeta(content: WebContent): WebSignals {
  const signals: Signal[] = [];

  // --- Redirect mismatch (requested vs final URL different domain) ---
  if (content.redirectChain.length > 0) {
    try {
      const originalDomain = new URL(content.url).hostname;
      const finalDomain = new URL(content.finalUrl).hostname;
      if (originalDomain !== finalDomain) {
        signals.push({
          signal: "url_redirect_mismatch",
          severity: "medium",
          detail: `${content.url} → ${content.finalUrl}`,
          url: content.url,
          finalUrl: content.finalUrl,
        });
      }
    } catch {}
  }

  // --- Excessive redirects ---
  if (content.redirectChain.length > 3) {
    signals.push({
      signal: "excessive_redirects",
      severity: "medium",
      detail: `${content.redirectChain.length} redirects`,
    });
  }

  // --- TLS invalid ---
  if (!content.tls.valid && content.url.startsWith("https://")) {
    signals.push({
      signal: "tls_invalid",
      severity: "high",
    });
  }

  // --- TLS expiring soon ---
  if (content.tls.expires) {
    try {
      const expiryDate = new Date(content.tls.expires);
      const daysUntilExpiry = (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilExpiry < 7 && daysUntilExpiry > 0) {
        signals.push({
          signal: "tls_expiring_soon",
          severity: "low",
          detail: `expires in ${Math.round(daysUntilExpiry)} days`,
        });
      } else if (daysUntilExpiry <= 0) {
        signals.push({
          signal: "tls_expired",
          severity: "high",
          detail: `expired ${content.tls.expires}`,
        });
      }
    } catch {}
  }

  // --- Credential form detection ---
  const forms = content.parts.filter(p => p.type === "form") as Array<{ type: "form"; action: string; method: string; fields: Array<{ name: string; type: string; label: string }> }>;
  for (const form of forms) {
    const hasPasswordField = form.fields.some(f => f.type === "password");
    const hasEmailField = form.fields.some(f =>
      f.type === "email" || f.name.includes("email") || f.name.includes("user") || f.name.includes("login")
    );
    if (hasPasswordField) {
      signals.push({
        signal: "credential_form_detected",
        severity: "medium",
        detail: `form action=${form.action}, has password field${hasEmailField ? " + email/user field" : ""}`,
      });
    }
  }

  // --- Script detection ---
  const scripts = content.parts.filter(p => p.type === "script_detected");
  if (scripts.length > 0) {
    signals.push({
      signal: "scripts_detected",
      severity: "low",
      detail: scripts.map(s => (s as any).context).join("; "),
      count: scripts.length,
    });
  }

  return { signals };
}
