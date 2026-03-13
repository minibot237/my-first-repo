/**
 * Code-based link evaluation — deterministic signals from URLs.
 * Spec: .local/doc/content-vocabulary.md → Canary Tool Contracts → evaluateLinks
 */

import type { LinkPart } from "../ingest/types.js";
import type { LinkSignals, Signal } from "../ingest/types.js";

export function evaluateLinks(links: LinkPart[]): LinkSignals {
  const signals: Signal[] = [];

  for (const link of links) {
    // --- Display text / href mismatch ---
    // If the display text looks like a URL/domain but doesn't match href
    const textLooksLikeUrl = /^https?:\/\/|^www\.|\.com$|\.org$|\.net$|\.io$/i.test(link.text.trim());
    if (textLooksLikeUrl) {
      try {
        const hrefDomain = new URL(link.href).hostname.replace(/^www\./, "");
        const textDomain = link.text.trim()
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .split("/")[0]
          .toLowerCase();
        if (textDomain && hrefDomain && !hrefDomain.endsWith(textDomain) && !textDomain.endsWith(hrefDomain)) {
          signals.push({
            signal: "display_href_mismatch",
            severity: "high",
            detail: `text="${link.text}" href="${link.href}"`,
            link,
          });
        }
      } catch {
        // invalid URL in href — suspicious on its own
        signals.push({
          signal: "invalid_href",
          severity: "medium",
          detail: `href="${link.href}"`,
          link,
        });
      }
    }

    // --- Homograph detection (mixed scripts in domain) ---
    try {
      const hostname = new URL(link.href).hostname;
      // Check for non-ASCII characters in domain (IDN homograph)
      if (/[^\x00-\x7F]/.test(hostname)) {
        signals.push({
          signal: "idn_homograph",
          severity: "high",
          detail: `non-ASCII domain: ${hostname}`,
          link,
        });
      }
    } catch {}

    // --- Suspicious URL patterns ---
    const href = link.href.toLowerCase();

    // IP address URLs
    if (/^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(href)) {
      signals.push({ signal: "ip_address_url", severity: "high", detail: link.href, link });
    }

    // Data URIs (can carry payloads)
    if (href.startsWith("data:")) {
      signals.push({ signal: "data_uri", severity: "high", detail: link.href.slice(0, 50), link });
    }

    // Extremely long URLs (common in tracking, but can also be obfuscation)
    if (link.href.length > 2000) {
      signals.push({ signal: "extremely_long_url", severity: "low", detail: `${link.href.length} chars`, link });
    }

    // URL shorteners
    const shorteners = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly"];
    try {
      const hostname = new URL(link.href).hostname;
      if (shorteners.some(s => hostname === s || hostname.endsWith(`.${s}`))) {
        signals.push({ signal: "url_shortener", severity: "low", detail: link.href, link });
      }
    } catch {}

    // Double-encoded URLs
    if (/%25[0-9a-f]{2}/i.test(link.href)) {
      signals.push({ signal: "double_encoded_url", severity: "medium", detail: link.href.slice(0, 80), link });
    }
  }

  return { signals };
}
