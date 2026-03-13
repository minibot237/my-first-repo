/**
 * Content Vocabulary — JSON types for the ingestion pipeline.
 * Spec: .doc/content-vocabulary.md
 */

// --- Top-level envelope ---

export type ContentSource = "email" | "web" | "generated";
export type ContentType = "text" | "code" | "markup" | "data" | "mixed";

export interface ContentEnvelope {
  id: string;
  source: ContentSource;
  sourceId: string;
  sourceFit: number;          // 0.0–1.0, looked up from trust store
  type: ContentType;
  ingestedAt: string;         // ISO 8601 local timestamp
  content: EmailContent | WebContent | GeneratedContent;
}

// --- Parts (shared across email + web) ---

export interface TextPart {
  type: "text";
  content: string;
}

export interface HtmlConvertedPart {
  type: "html_converted";
  content: string;
  links: LinkPart[];
  images: ImagePart[];
}

export interface LinkPart {
  type: "link";
  href: string;
  text: string;
  context: string;            // surrounding sentence/paragraph
}

export interface ImagePart {
  type: "image";
  src: string;
  alt: string;
  context: string;
}

export interface AttachmentPart {
  type: "attachment";
  filename: string;
  mimeType: string;
  size: number;
}

export interface HeaderAnomalyPart {
  type: "header_anomaly";
  name: string;
  value: string;
  signal: string;             // e.g. "from_returnpath_mismatch"
}

export type ContentPart =
  | TextPart
  | HtmlConvertedPart
  | LinkPart
  | ImagePart
  | AttachmentPart
  | HeaderAnomalyPart;

// --- Email ---

export interface EmailAddress {
  name: string;
  address: string;
}

export interface ReceivedHop {
  from: string;
  by: string;
  timestamp: string;
}

export interface EmailAuth {
  spf: "pass" | "fail" | "softfail" | "none";
  dkim: "pass" | "fail" | "none";
  dmarc: "pass" | "fail" | "none";
}

export interface EmailEnvelope {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  date: string;
  messageId: string;
  inReplyTo: string | null;
  replyTo: string | null;
  returnPath: string | null;
  receivedChain: ReceivedHop[];
  auth: EmailAuth;
}

export interface RawHeader {
  name: string;
  value: string;
}

export interface EmailContent {
  type: "email";
  envelope: EmailEnvelope;
  parts: ContentPart[];
  rawHeaders: RawHeader[];
}

// --- Web ---

export interface TlsInfo {
  valid: boolean;
  issuer: string;
  expires: string;
}

export interface WebMeta {
  type: "meta";
  name: string;
  content: string;
}

export interface FormField {
  name: string;
  type: string;
  label: string;
}

export interface FormPart {
  type: "form";
  action: string;
  method: string;
  fields: FormField[];
}

export interface ScriptDetectedPart {
  type: "script_detected";
  context: string;
}

export type WebPart = ContentPart | WebMeta | FormPart | ScriptDetectedPart;

export interface WebContent {
  type: "web";
  url: string;
  finalUrl: string;
  title: string;
  fetchedAt: string;
  redirectChain: string[];
  tls: TlsInfo;
  parts: WebPart[];
  meta: WebMeta[];
}

// --- Generated ---

export interface GeneratedContent {
  type: "generated";
  sessionId: string;
  sessionType: "core" | "coder" | "canary";
  inputRefs: string[];        // content ids of inputs
  parts: ContentPart[];
}

// --- Canary tool signals ---

export type SignalSeverity = "low" | "medium" | "high" | "critical";

export interface Signal {
  signal: string;
  severity: SignalSeverity;
  detail?: string;
  [key: string]: unknown;     // type-specific extra fields (link, filename, etc.)
}

export interface EnvelopeSignals {
  authScore: number;          // 0.0–1.0
  signals: Signal[];
  sourceFitDelta: number;     // -0.15 to +0.05
}

export interface LinkSignals {
  signals: Signal[];
}

export interface AttachmentSignals {
  signals: Signal[];
}

export interface WebSignals {
  signals: Signal[];
}

export interface LlmPayload {
  codeSignals: Signal[];
  contentBlocks: ContentPart[];
}
