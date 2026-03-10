/**
 * Web content ingestion — fetch URL and produce ContentEnvelope.
 * Spec: docs/content-vocabulary.md
 */

import { randomUUID } from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";
import { load as cheerioLoad } from "cheerio";
import { localTimestamp } from "../log.js";
import type {
  ContentEnvelope,
  WebContent,
  WebPart,
  WebMeta,
  LinkPart,
  ImagePart,
  FormPart,
  ScriptDetectedPart,
  TlsInfo,
  ContentType,
} from "./types.js";

const DEFAULT_FIT = 0.5;
const MAX_REDIRECTS = 10;
const TIMEOUT_MS = 15_000;

// --- Public API ---

/** Fetch a URL and produce a ContentEnvelope */
export async function ingestWeb(url: string): Promise<ContentEnvelope> {
  const { body, finalUrl, redirectChain, tls } = await fetchWithTracking(url);

  const $ = cheerioLoad(body);
  const title = extractTitle($);
  const meta = extractMeta($);
  const parts = extractParts($, finalUrl);

  const content: WebContent = {
    type: "web",
    url,
    finalUrl,
    title,
    fetchedAt: localTimestamp(),
    redirectChain,
    tls,
    parts,
    meta,
  };

  const domain = new URL(finalUrl).hostname;

  return {
    id: randomUUID(),
    source: "web",
    sourceId: domain,
    sourceFit: DEFAULT_FIT,     // TODO: trust store lookup
    type: classifyContentType(parts),
    ingestedAt: localTimestamp(),
    content,
  };
}

// --- HTTP fetch with redirect + TLS tracking ---

interface FetchResult {
  body: string;
  finalUrl: string;
  redirectChain: string[];
  tls: TlsInfo;
}

async function fetchWithTracking(url: string): Promise<FetchResult> {
  const redirectChain: string[] = [];
  let currentUrl = url;
  let tls: TlsInfo = { valid: false, issuer: "", expires: "" };

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const result = await fetchOne(currentUrl);

    // Capture TLS from the first HTTPS request
    if (i === 0 && result.tls) {
      tls = result.tls;
    }

    if (result.redirect) {
      redirectChain.push(currentUrl);
      // Handle relative redirects
      currentUrl = new URL(result.redirect, currentUrl).href;
      continue;
    }

    return { body: result.body, finalUrl: currentUrl, redirectChain, tls };
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
}

interface FetchOneResult {
  body: string;
  redirect: string | null;
  tls: TlsInfo | null;
}

function fetchOne(url: string): Promise<FetchOneResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(url, {
      method: "GET",
      timeout: TIMEOUT_MS,
      headers: {
        "User-Agent": "minibot/0.1",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }, (res) => {
      let tls: TlsInfo | null = null;

      // Extract TLS info from the socket
      if (isHttps && res.socket && "getPeerCertificate" in res.socket) {
        try {
          const cert = (res.socket as any).getPeerCertificate();
          if (cert && cert.issuer) {
            const issuerParts = [];
            if (cert.issuer.O) issuerParts.push(cert.issuer.O);
            if (cert.issuer.CN) issuerParts.push(cert.issuer.CN);
            tls = {
              valid: (res.socket as any).authorized ?? false,
              issuer: issuerParts.join(" / ") || "unknown",
              expires: cert.valid_to ?? "",
            };
          }
        } catch {
          // TLS info extraction failed — not critical
        }
      }

      // Handle redirects manually
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        // Consume body to free the socket
        res.resume();
        resolve({ body: "", redirect: res.headers.location, tls });
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve({ body, redirect: null, tls });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

// --- Content extraction ---

function extractTitle($: ReturnType<typeof cheerioLoad>): string {
  // Prefer og:title, then <title>
  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle) return ogTitle;
  return $("title").first().text().trim();
}

function extractMeta($: ReturnType<typeof cheerioLoad>): WebMeta[] {
  const metas: WebMeta[] = [];
  $("meta").each((_, el) => {
    const name = $(el).attr("name") ?? $(el).attr("property") ?? "";
    const content = $(el).attr("content") ?? "";
    if (name && content) {
      metas.push({ type: "meta", name, content });
    }
  });
  return metas;
}

function extractParts($: ReturnType<typeof cheerioLoad>, baseUrl: string): WebPart[] {
  const parts: WebPart[] = [];

  // Remove boilerplate elements before extracting content
  $("nav, footer, header, aside, [role='navigation'], [role='banner'], [role='contentinfo']").remove();
  $(".nav, .navbar, .footer, .sidebar, .ad, .advertisement, .cookie-banner").remove();
  $("script, style, noscript, iframe").remove();

  // Main text content
  const textContent = extractMainText($);
  if (textContent) {
    parts.push({ type: "text", content: textContent });
  }

  // Links
  const links = extractLinks($, baseUrl);
  for (const link of links) {
    parts.push(link);
  }

  // Images
  const images = extractImages($, baseUrl);
  for (const img of images) {
    parts.push(img);
  }

  // Forms
  const forms = extractForms($, baseUrl);
  for (const form of forms) {
    parts.push(form);
  }

  // Script detection (we already removed script tags, but record that they existed)
  // Re-parse original to count scripts
  // Note: we detect before removal would be better, so check the original body
  // For now, we'll note this as a known limitation

  return parts;
}

function extractMainText($: ReturnType<typeof cheerioLoad>): string {
  // Try common main content selectors
  const mainSelectors = [
    "main", "article", "[role='main']",
    ".content", ".post-content", ".entry-content", ".article-body",
    "#content", "#main", "#article",
  ];

  for (const selector of mainSelectors) {
    const el = $(selector).first();
    if (el.length && el.text().trim().length > 100) {
      return cleanText(el.text());
    }
  }

  // Fallback: body text
  return cleanText($("body").text());
}

function extractLinks($: ReturnType<typeof cheerioLoad>, baseUrl: string): LinkPart[] {
  const links: LinkPart[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const $el = $(el);
    let href = $el.attr("href") ?? "";
    const text = $el.text().trim();

    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;

    // Resolve relative URLs
    try {
      href = new URL(href, baseUrl).href;
    } catch {
      return;
    }

    // Dedup
    const key = `${href}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);

    // Context: parent paragraph or surrounding text
    const parent = $el.closest("p, li, td, div").first();
    const context = parent.length ? cleanText(parent.text()).slice(0, 200) : "";

    links.push({ type: "link", href, text, context });
  });

  return links;
}

function extractImages($: ReturnType<typeof cheerioLoad>, baseUrl: string): ImagePart[] {
  const images: ImagePart[] = [];

  $("img[src]").each((_, el) => {
    const $el = $(el);
    let src = $el.attr("src") ?? "";
    const alt = $el.attr("alt") ?? "";

    // Skip tiny tracking pixels and data URIs
    const width = parseInt($el.attr("width") ?? "999", 10);
    const height = parseInt($el.attr("height") ?? "999", 10);
    if (width <= 1 || height <= 1) return;
    if (src.startsWith("data:")) return;

    try {
      src = new URL(src, baseUrl).href;
    } catch {
      return;
    }

    const parent = $el.closest("figure, p, div").first();
    const context = parent.length ? cleanText(parent.text()).slice(0, 200) : "";

    images.push({ type: "image", src, alt, context });
  });

  return images;
}

function extractForms($: ReturnType<typeof cheerioLoad>, baseUrl: string): FormPart[] {
  const forms: FormPart[] = [];

  $("form").each((_, el) => {
    const $form = $(el);
    let action = $form.attr("action") ?? "";
    const method = ($form.attr("method") ?? "get").toUpperCase();

    try {
      action = new URL(action, baseUrl).href;
    } catch {
      // keep as-is
    }

    const fields: FormPart["fields"] = [];
    $form.find("input, select, textarea").each((_, field) => {
      const $field = $(field);
      const name = $field.attr("name") ?? "";
      const type = $field.attr("type") ?? $field.prop("tagName")?.toLowerCase() ?? "";
      // Try to find a label
      const id = $field.attr("id");
      let label = "";
      if (id) {
        label = $(`label[for="${id}"]`).text().trim();
      }
      if (!label) {
        label = $field.attr("placeholder") ?? $field.attr("aria-label") ?? "";
      }
      if (name || type) {
        fields.push({ name, type, label });
      }
    });

    if (fields.length > 0) {
      forms.push({ type: "form", action, method, fields });
    }
  });

  return forms;
}

// --- Script detection (run before removal) ---

export function detectScripts(html: string): ScriptDetectedPart[] {
  const parts: ScriptDetectedPart[] = [];
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;

  while ((match = scriptRegex.exec(html)) !== null) {
    count++;
    // Only flag inline scripts (not external src= scripts)
    if (!match[0].includes(" src=") && match[1].trim().length > 0) {
      const preview = match[1].trim().slice(0, 100);
      parts.push({ type: "script_detected", context: `inline script: ${preview}...` });
    }
  }

  if (count > 0 && parts.length === 0) {
    // All scripts were external
    parts.push({ type: "script_detected", context: `${count} external script(s)` });
  }

  return parts;
}

// --- Utilities ---

function cleanText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/gm, "")
    .trim();
}

function classifyContentType(parts: WebPart[]): ContentType {
  const hasText = parts.some(p => p.type === "text");
  const hasForms = parts.some(p => p.type === "form");
  if (hasForms && hasText) return "mixed";
  return hasText ? "text" : "markup";
}
