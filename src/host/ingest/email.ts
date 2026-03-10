/**
 * Email ingestion — parse .eml files into ContentEnvelope.
 * Spec: docs/content-vocabulary.md
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import { localTimestamp } from "../log.js";
import type {
  ContentEnvelope,
  EmailContent,
  EmailEnvelope,
  EmailAddress,
  EmailAuth,
  ReceivedHop,
  RawHeader,
  ContentPart,
  TextPart,
  HtmlConvertedPart,
  LinkPart,
  ImagePart,
  AttachmentPart,
  HeaderAnomalyPart,
  ContentType,
} from "./types.js";

const DEFAULT_FIT = 0.5;

/** Optional trust lookup — returns sourceFit for a sourceId */
export type FitLookup = (sourceId: string) => number;

// --- Public API ---

/** Parse a raw .eml file into a ContentEnvelope */
export async function ingestEmail(emlPath: string, lookupFit?: FitLookup): Promise<ContentEnvelope> {
  const raw = await readFile(emlPath);
  const parsed = await simpleParser(raw);

  const envelope = extractEnvelope(parsed);
  const parts = extractParts(parsed);
  const rawHeaders = extractRawHeaders(parsed);
  const anomalies = detectHeaderAnomalies(envelope, rawHeaders);

  const allParts: ContentPart[] = [...parts, ...anomalies];

  const content: EmailContent = {
    type: "email",
    envelope,
    parts: allParts,
    rawHeaders,
  };

  return {
    id: randomUUID(),
    source: "email",
    sourceId: envelope.from.address,
    sourceFit: lookupFit ? lookupFit(envelope.from.address) : DEFAULT_FIT,
    type: classifyContentType(parts),
    ingestedAt: localTimestamp(),
    content,
  };
}

/** Parse from a raw email buffer (for non-file sources) */
export async function ingestEmailBuffer(buffer: Buffer, lookupFit?: FitLookup): Promise<ContentEnvelope> {
  const parsed = await simpleParser(buffer);

  const envelope = extractEnvelope(parsed);
  const parts = extractParts(parsed);
  const rawHeaders = extractRawHeaders(parsed);
  const anomalies = detectHeaderAnomalies(envelope, rawHeaders);

  const allParts: ContentPart[] = [...parts, ...anomalies];

  const content: EmailContent = {
    type: "email",
    envelope,
    parts: allParts,
    rawHeaders,
  };

  return {
    id: randomUUID(),
    source: "email",
    sourceId: envelope.from.address,
    sourceFit: lookupFit ? lookupFit(envelope.from.address) : DEFAULT_FIT,
    type: classifyContentType(parts),
    ingestedAt: localTimestamp(),
    content,
  };
}

// --- Envelope extraction ---

function extractEnvelope(parsed: ParsedMail): EmailEnvelope {
  const from = extractFirstAddress(parsed.from) ?? { name: "", address: "unknown" };
  const to = extractAddresses(parsed.to);
  const cc = extractAddresses(parsed.cc);

  return {
    from,
    to,
    cc,
    subject: parsed.subject ?? "",
    date: parsed.date?.toISOString() ?? "",
    messageId: parsed.messageId ?? "",
    inReplyTo: parsed.inReplyTo ?? null,
    replyTo: extractFirstAddress(parsed.replyTo)?.address ?? null,
    returnPath: getHeaderValue(parsed, "return-path"),
    receivedChain: parseReceivedChain(parsed),
    auth: extractAuth(parsed),
  };
}

function extractFirstAddress(addr: AddressObject | AddressObject[] | undefined): EmailAddress | null {
  if (!addr) return null;
  const obj = Array.isArray(addr) ? addr[0] : addr;
  const first = obj?.value?.[0];
  if (!first) return null;
  return { name: first.name ?? "", address: first.address ?? "" };
}

function extractAddresses(addr: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!addr) return [];
  const objects = Array.isArray(addr) ? addr : [addr];
  return objects.flatMap(obj =>
    (obj.value ?? []).map(v => ({ name: v.name ?? "", address: v.address ?? "" }))
  );
}

// --- Auth extraction ---

function extractAuth(parsed: ParsedMail): EmailAuth {
  const authHeader =
    getHeaderValue(parsed, "authentication-results") ??
    getHeaderValue(parsed, "arc-authentication-results") ??
    "";

  return {
    spf: extractSpf(authHeader),
    dkim: extractDkimOrDmarc(authHeader, "dkim"),
    dmarc: extractDkimOrDmarc(authHeader, "dmarc"),
  };
}

function extractSpf(header: string): EmailAuth["spf"] {
  const match = header.match(/spf=(\w+)/i);
  if (!match) return "none";
  const r = match[1].toLowerCase();
  if (r === "pass") return "pass";
  if (r === "fail") return "fail";
  if (r === "softfail") return "softfail";
  return "none";
}

function extractDkimOrDmarc(header: string, mechanism: "dkim" | "dmarc"): "pass" | "fail" | "none" {
  const match = header.match(new RegExp(`${mechanism}=(\\w+)`, "i"));
  if (!match) return "none";
  const r = match[1].toLowerCase();
  if (r === "pass") return "pass";
  if (r === "fail") return "fail";
  return "none";
}

// --- Received chain ---

function parseReceivedChain(parsed: ParsedMail): ReceivedHop[] {
  const headers = parsed.headers;
  const received = headers.get("received");
  if (!received) return [];

  const values = Array.isArray(received) ? received : [received];
  return values.map(raw => {
    const str = typeof raw === "string" ? raw : String(raw);
    const fromMatch = str.match(/from\s+(\S+)/i);
    const byMatch = str.match(/by\s+(\S+)/i);
    const dateMatch = str.match(/;\s*(.+)$/);
    return {
      from: fromMatch?.[1] ?? "",
      by: byMatch?.[1] ?? "",
      timestamp: dateMatch?.[1]?.trim() ?? "",
    };
  });
}

// --- Header utilities ---

function getHeaderValue(parsed: ParsedMail, name: string): string | null {
  const val = parsed.headers.get(name);
  if (!val) return null;
  if (typeof val === "string") return val;
  // mailparser sometimes returns structured objects for addresses
  if (Array.isArray(val)) {
    // Array of objects (e.g. Return-Path parsed as address list)
    return val.map(v => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "text" in v) return (v as any).text;
      if (v && typeof v === "object" && "value" in v) {
        const addrs = (v as any).value;
        if (Array.isArray(addrs)) return addrs.map((a: any) => a.address ?? "").join(", ");
      }
      return String(v);
    }).join(", ");
  }
  if (typeof val === "object" && "text" in (val as any)) return (val as any).text;
  if (typeof val === "object" && "value" in (val as any)) {
    const addrs = (val as any).value;
    if (Array.isArray(addrs)) return addrs.map((a: any) => a.address ?? "").join(", ");
  }
  return String(val);
}

function extractRawHeaders(parsed: ParsedMail): RawHeader[] {
  const result: RawHeader[] = [];
  parsed.headers.forEach((value, key) => {
    const strVal = typeof value === "string" ? value : JSON.stringify(value);
    result.push({ name: key, value: strVal });
  });
  return result;
}

// --- Content parts extraction ---

function extractParts(parsed: ParsedMail): ContentPart[] {
  const parts: ContentPart[] = [];

  // Plain text body
  if (parsed.text) {
    parts.push({ type: "text", content: parsed.text } as TextPart);
  }

  // HTML body — convert and extract structured elements
  if (parsed.html) {
    const { content, links, images } = extractFromHtml(parsed.html);
    parts.push({
      type: "html_converted",
      content,
      links,
      images,
    } as HtmlConvertedPart);
  }

  // Attachments
  if (parsed.attachments) {
    for (const att of parsed.attachments) {
      parts.push({
        type: "attachment",
        filename: att.filename ?? "unnamed",
        mimeType: att.contentType ?? "application/octet-stream",
        size: att.size ?? 0,
      } as AttachmentPart);
    }
  }

  return parts;
}

// --- HTML extraction ---

/** Extract text content, links, and images from HTML body */
function extractFromHtml(html: string): {
  content: string;
  links: LinkPart[];
  images: ImagePart[];
} {
  const links: LinkPart[] = [];
  const images: ImagePart[] = [];

  // Extract links with context
  const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = stripTags(match[2]).trim();
    if (href && text) {
      // Grab surrounding context (rough: 100 chars before and after)
      const start = Math.max(0, match.index - 100);
      const end = Math.min(html.length, match.index + match[0].length + 100);
      const context = stripTags(html.slice(start, end)).trim();
      links.push({ type: "link", href, text, context });
    }
  }

  // Extract images
  const imgRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*\/?>/gi;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    const altMatch = match[0].match(/alt=["']([^"']*?)["']/i);
    const alt = altMatch?.[1] ?? "";
    const start = Math.max(0, match.index - 100);
    const end = Math.min(html.length, match.index + match[0].length + 100);
    const context = stripTags(html.slice(start, end)).trim();
    images.push({ type: "image", src, alt, context });
  }

  // Strip HTML to plain text (basic but functional)
  const content = htmlToText(html);

  return { content, links, images };
}

/** Basic HTML to text conversion */
function htmlToText(html: string): string {
  let text = html;
  // Remove style and script blocks
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  // Block elements get newlines
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
}

// --- Header anomaly detection ---

function detectHeaderAnomalies(
  envelope: EmailEnvelope,
  rawHeaders: RawHeader[]
): HeaderAnomalyPart[] {
  const anomalies: HeaderAnomalyPart[] = [];

  // From / Return-Path mismatch
  if (envelope.returnPath) {
    const returnDomain = domainOf(envelope.returnPath);
    const fromDomain = domainOf(envelope.from.address);
    if (returnDomain && fromDomain && returnDomain !== fromDomain) {
      // Allow known ESP patterns (sparkpost, sendgrid, etc.)
      const knownEsps = [
        "sparkpost.com", "sendgrid.net", "amazonses.com", "mailgun.org", "mandrillapp.com",
        "beehiiv.com", "mcsv.net", "mcdlv.net", "mailchimp.com", "rsgsv.net",   // mailchimp/beehiiv
        "convertkit-mail.com", "convertkit.com", "ckespa.",                        // convertkit
        "createsend.com", "cmail19.com", "cmail20.com",                            // campaign monitor
        "constantcontact.com", "bnc3.com",                                         // constant contact
        "hubspot.com", "hubspotemail.net",                                         // hubspot
        "klaviyo.com", "klaviyomail.com",                                          // klaviyo
        "substack.com",                                                            // substack
      ];
      const isKnownEsp = knownEsps.some(esp => returnDomain.endsWith(esp));
      if (!isKnownEsp) {
        anomalies.push({
          type: "header_anomaly",
          name: "Return-Path",
          value: envelope.returnPath,
          signal: "from_returnpath_mismatch",
        });
      }
    }
  }

  // Reply-To mismatch
  if (envelope.replyTo) {
    const replyDomain = domainOf(envelope.replyTo);
    const fromDomain = domainOf(envelope.from.address);
    if (replyDomain && fromDomain && replyDomain !== fromDomain) {
      anomalies.push({
        type: "header_anomaly",
        name: "Reply-To",
        value: envelope.replyTo,
        signal: "replyto_domain_mismatch",
      });
    }
  }

  // Auth failures
  if (envelope.auth.spf === "fail") {
    anomalies.push({
      type: "header_anomaly",
      name: "SPF",
      value: "fail",
      signal: "spf_fail",
    });
  }
  if (envelope.auth.dkim === "fail") {
    anomalies.push({
      type: "header_anomaly",
      name: "DKIM",
      value: "fail",
      signal: "dkim_fail",
    });
  }
  if (envelope.auth.dmarc === "fail") {
    anomalies.push({
      type: "header_anomaly",
      name: "DMARC",
      value: "fail",
      signal: "dmarc_fail",
    });
  }

  return anomalies;
}

function domainOf(emailOrPath: string): string | null {
  // Handle "<addr>" wrapper and Return-Path format
  const cleaned = emailOrPath.replace(/[<>]/g, "");
  const atIdx = cleaned.lastIndexOf("@");
  if (atIdx === -1) return null;
  return cleaned.slice(atIdx + 1).toLowerCase();
}

// --- Content type classification ---

function classifyContentType(parts: ContentPart[]): ContentType {
  const hasText = parts.some(p => p.type === "text");
  const hasHtml = parts.some(p => p.type === "html_converted");
  const hasAttachments = parts.some(p => p.type === "attachment");

  if (hasAttachments && (hasText || hasHtml)) return "mixed";
  if (hasHtml) return "markup";
  return "text";
}
